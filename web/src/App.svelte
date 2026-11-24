<script lang="ts">
  import { onMount } from 'svelte';
  import Icon, { type IconName } from './components/Icon.svelte';
  import DriveMenu from './components/DriveMenu.svelte';
  import DiagramDialog from './components/DiagramDialog.svelte';
  import { DriveApi } from './lib/drive/api';
  import { RedirectAuth } from './lib/drive/auth';
  import { DriveController, localFlag, type DriveUiState } from './lib/drive/controller';
  import { localSyncStateStore } from './lib/drive/sync';
  import { worldToScreen, type Camera, type Vec } from './lib/camera';
  import { boardFromJson, isClipboard, loadCore, newBoard } from './lib/core';
  import { Editor, INK_COLORS, type PointerInput, type TextRequest, type Tool } from './lib/editor';
  import { Renderer } from './lib/renderer';
  import { BACKGROUNDS, DEFAULT_BACKGROUND, displayInk, isDark, resolveBackground } from './lib/background';
  import { DEFAULT_EXPORT } from './lib/exportImage';
  import { ACCEPTED_TYPES, loadImageFile, pickImageFiles, type LoadedImage } from './lib/images';
  import { BLANK_DIAGRAM, TEMPLATES, type DiagramInsert } from './lib/mermaid';
  import { BLANK_PLAIN } from './lib/plainDiagram';
  import { Autosaver, EmergencyBackup, IndexedDbStore, type SaveStatus } from './lib/storage';
  import { DEFAULT_FONT_SIZE, FONT_FAMILY, LINE_HEIGHT, fontString, measureText, type TextSize } from './lib/text';

  const tools: { id: Tool; label: string; icon: IconName; key: string }[] = [
    { id: 'select', label: 'Seleção', icon: 'select', key: 'V' },
    { id: 'hand', label: 'Mão (arrastar a vista)', icon: 'hand', key: 'H' },
    { id: 'rectangle', label: 'Retângulo', icon: 'rectangle', key: 'R' },
    { id: 'arrow', label: 'Seta', icon: 'arrow', key: 'A' },
    { id: 'figure', label: 'Boneco (clique ou arraste)', icon: 'figure', key: 'B' },
    { id: 'pencil', label: 'Lápis', icon: 'pencil', key: 'P' },
    { id: 'text', label: 'Texto', icon: 'text', key: 'T' },
    { id: 'eraser', label: 'Borracha', icon: 'eraser', key: 'E' },
  ];

  const statusText: Record<SaveStatus, string> = {
    saved: 'Salvo neste navegador',
    pending: 'Alterações pendentes',
    saving: 'Salvando…',
    error: 'Não foi possível salvar',
  };

  /** Caixa de texto aberta: o que está sendo digitado e onde. */
  interface TextEditing extends TextRequest {
    value: string;
    color: string;
    fontSize: number;
  }

  let canvas: HTMLCanvasElement | undefined = $state();
  let textarea: HTMLTextAreaElement | undefined = $state();
  let tool = $state<Tool>('pencil');
  let color = $state<string>(INK_COLORS[0]);
  let camera = $state<Camera>({ x: 0, y: 0, zoom: 1 });
  let status = $state<SaveStatus>('saved');
  let notice = $state<string | null>(null);
  /** Aviso curto que some sozinho (por exemplo, "Copiado como PNG"). */
  let toast = $state<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let spaceHeld = $state(false);
  let panning = $state(false);
  /** Quantos elementos estão selecionados (a barra mostra as ações de seleção quando há algum). */
  let selectedCount = $state(0);
  let editing = $state<TextEditing | null>(null);
  /** Cursor de redimensionar quando o mouse passa por uma alça. */
  let hoverCursor = $state<string | null>(null);
  let canUndo = $state(false);
  /** Sem ID de cliente configurado, o Drive fica escondido (veja o README). */
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() || null;
  let driveState = $state<DriveUiState>('off');
  let driveDetail = $state<string | null>(null);
  let driveFolderUrl = $state<string | null>(null);
  let drive: DriveController | null = null;
  let canRedo = $state(false);
  /** Janela de diagrama aberta: título, texto inicial e se o texto é simples ou Mermaid. */
  let diagram = $state<{ title: string; code: string; language: 'plain' | 'mermaid' } | null>(null);
  /** Submenu de diagrama aberto, posicionado embaixo do botão (fora da barra, que rola). */
  let diagramMenu = $state<{ left: number; top: number } | null>(null);
  /** Cor de fundo do quadro aberto. */
  let background = $state<string>(DEFAULT_BACKGROUND);
  /** Menu de fundo aberto, posicionado embaixo do botão. */
  let backgroundMenu = $state<{ left: number; top: number } | null>(null);

  let editor: Editor | null = null;
  let autosaver: Autosaver | null = null;
  const renderer = new Renderer(() => requestDraw());
  /** Cópia síncrona do desenho para quando a página sai (fechar, recarregar, ir para o Google). */
  const emergencyBackup = new EmergencyBackup();
  let fileInput: HTMLInputElement | undefined = $state();
  /** Último ponto do mouse sobre o quadro: é onde a imagem colada entra. */
  let lastPointer: Vec | null = null;
  const view = { width: 0, height: 0, dpr: 1 };
  let frame = 0;

  /** Medida de texto com a fonte de verdade, num canvas fora da tela. */
  const measureCtx = document.createElement('canvas').getContext('2d');
  function measure(value: string, fontSize: number): TextSize {
    return measureText(value, fontSize, (line) => {
      if (!measureCtx) return line.length * fontSize * 0.5;
      measureCtx.font = fontString(fontSize);
      return measureCtx.measureText(line).width;
    });
  }

  function toggleDiagramMenu(e: MouseEvent): void {
    if (diagramMenu) {
      diagramMenu = null;
      return;
    }
    commitText();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    diagramMenu = { left: Math.max(8, Math.min(r.left, window.innerWidth - 268)), top: r.bottom + 8 };
  }

  function openDiagram(title: string, code: string, language: 'plain' | 'mermaid' = 'mermaid'): void {
    diagramMenu = null;
    diagram = { title, code, language };
  }

  /** Põe o diagrama no centro da tela, já selecionado para mover ou redimensionar. */
  function insertDiagram(result: DiagramInsert): void {
    if (!editor) return;
    if (result.kind === 'shapes') editor.insertDiagram(result.shapes, center(), viewport(), measure, 0.8);
    else editor.insertImage(result.image, center(), viewport(), 0.8);
    tool = 'select';
    diagram = null;
    requestDraw();
  }

  function toggleBackgroundMenu(e: MouseEvent): void {
    if (backgroundMenu) {
      backgroundMenu = null;
      return;
    }
    commitText();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    backgroundMenu = { left: Math.max(8, Math.min(r.left, window.innerWidth - 188)), top: r.bottom + 8 };
  }

  function chooseBackground(next: string): void {
    backgroundMenu = null;
    editor?.setBackground(next);
    syncBackground();
  }

  function syncBackground(): void {
    background = resolveBackground(editor?.background);
  }

  function onWindowPointerDown(e: PointerEvent): void {
    const target = e.target as Element | null;
    if (diagramMenu && !target?.closest('.diagram-menu, .diagram-button')) diagramMenu = null;
    if (backgroundMenu && !target?.closest('.background-menu, .background-button')) backgroundMenu = null;
  }

  function requestDraw(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const ctx = canvas?.getContext('2d');
      if (!editor || !ctx) return;
      renderer.draw(ctx, editor.board, editor.camera, view.width, view.height, view.dpr, {
        selectedIds: editor.selectedIds,
        marquee: editor.marquee,
        hiddenId: editing?.id ?? null,
      });
      camera = { ...editor.camera };
      panning = editor.isPanning;
    });
  }

  /**
   * Tamanho da tela. O `ResizeObserver` atualiza `view`, mas numa aba aberta em segundo
   * plano ele pode demorar a avisar: aí mede na hora, para nada ser posto com tamanho zero.
   */
  function viewport() {
    if ((view.width === 0 || view.height === 0) && canvas) {
      const rect = canvas.getBoundingClientRect();
      view.width = rect.width;
      view.height = rect.height;
    }
    return view;
  }

  function center() {
    const v = viewport();
    return { x: v.width / 2, y: v.height / 2 };
  }

  function selectTool(next: Tool): void {
    commitText();
    tool = next;
    if (editor) editor.tool = next;
    requestDraw();
  }

  function selectColor(next: string): void {
    color = next;
    if (editor) editor.ink = { ...editor.ink, color: next };
  }

  function deleteSelected(): void {
    editor?.deleteSelected();
  }

  // --- Google Drive ------------------------------------------------------

  function startDrive(): void {
    if (!googleClientId || !editor) return;
    const auth = new RedirectAuth(googleClientId);
    // Se a página acabou de voltar do Google, guarda o acesso (ou mostra o erro).
    const back = auth.completeRedirect();
    if (back && !back.ok) notice = back.error;
    drive = new DriveController({
      auth,
      drive: new DriveApi(() => auth.token()),
      getJson: () => editor?.board.toJson() ?? '',
      mergeRemote: (json) => editor?.mergeRemote(json),
      stateStore: localSyncStateStore(),
      connectedFlag: localFlag(),
      onState: (state, detail) => {
        driveState = state;
        driveDetail = detail ?? null;
        driveFolderUrl = drive?.folderUrl ?? null;
        if (detail && (state === 'off' || state === 'needs-auth')) notice = detail;
      },
    });
    void drive.start();
  }

  function connectDrive(mode: 'consent' | 'silent'): void {
    commitText();
    // A página vai para o Google e volta: grava o desenho antes de sair.
    if (editor) {
      emergencyBackup.write(editor.board.toJson());
      void autosaver?.flush();
    }
    void drive?.connect(mode);
  }

  // --- Imagens -----------------------------------------------------------

  /** Põe as imagens no quadro a partir de `at` (tela); várias de uma vez ficam em cascata. */
  async function addImages(files: File[], at: Vec): Promise<void> {
    if (!editor || files.length === 0) return;
    commitText();
    for (const [i, file] of files.entries()) {
      try {
        const image = await loadImageFile(file);
        tool = 'select';
        editor.insertImage(image, { x: at.x + i * 24, y: at.y + i * 24 }, viewport());
      } catch (err) {
        console.error(err);
        notice = err instanceof Error ? err.message : 'Não foi possível abrir a imagem.';
      }
    }
  }

  function onFilesChosen(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    void addImages(pickImageFiles(input.files), center());
    input.value = '';
  }

  // --- Copiar, recortar e colar -----------------------------------------

  const isTyping = (e: Event): boolean => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

  /** Marca que o evento `copy` gravou o conteúdo (ver `copyByKey`). */
  let copiedByEvent = false;

  function onCopy(e: ClipboardEvent): void {
    if (isTyping(e) || !hasSelection() || !e.clipboardData || !editor) return;
    const json = editor.copySelection();
    if (!json) return;
    e.clipboardData.setData('text/plain', json);
    e.preventDefault();
    copiedByEvent = true;
  }

  function onCut(e: ClipboardEvent): void {
    if (isTyping(e) || !hasSelection() || !e.clipboardData || !editor) return;
    const json = editor.cutSelection();
    if (!json) return;
    e.clipboardData.setData('text/plain', json);
    e.preventDefault();
  }

  /**
   * Colar: imagem vira imagem; conteúdo copiado do draw4fun vira cópia dos elementos;
   * qualquer outro texto vira um elemento de texto.
   */
  function onPaste(e: ClipboardEvent): void {
    if (isTyping(e) || !editor) return;
    const files = pickImageFiles(e.clipboardData?.files);
    if (files.length > 0) {
      e.preventDefault();
      void addImages(files, lastPointer ?? center());
      return;
    }
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text.trim().length === 0) return;
    e.preventDefault();
    commitText();
    try {
      const inserted = isClipboard(text)
        ? editor.paste(text, lastPointer).length > 0
        : editor.pasteText(text, lastPointer ?? center(), measure(text, editor.fontSize)) !== null;
      if (inserted) tool = 'select';
    } catch (err) {
      console.error(err);
      notice = 'Não foi possível colar esse conteúdo.';
    }
  }

  /**
   * Ctrl/Cmd+C e +X tratados na tecla, porque o Safari nem sempre dispara o evento `copy`
   * quando não há texto selecionado na página. Primeiro pede ao navegador o comando de
   * copiar, que dispara `onCopy` na hora; se ele não vier, grava pela API de área de
   * transferência. Recortar é copiar e depois apagar.
   */
  function copyByKey(cut: boolean): boolean {
    if (!editor || !hasSelection()) return false;
    const json = editor.copySelection();
    if (!json) return false;
    copiedByEvent = false;
    try {
      document.execCommand('copy');
    } catch {
      // Navegador sem o comando: segue para a API.
    }
    if (!copiedByEvent) {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(json).catch((err: unknown) => {
          console.error(err);
          notice = 'O navegador não deixou copiar.';
        });
      } else {
        notice = 'O navegador não deixou copiar.';
      }
    }
    if (cut) editor.deleteSelected();
    return true;
  }

  function undo(): void {
    commitText();
    editor?.undo();
  }

  function redo(): void {
    commitText();
    editor?.redo();
  }

  function hasSelection(): boolean {
    return (editor?.selectedIds.length ?? 0) > 0;
  }

  function showToast(message: string): void {
    toast = message;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 2000);
  }

  /**
   * Copia os selecionados como imagem PNG (fundo branco, 2x). A imagem vai para a área de
   * transferência como promessa, dentro do clique: o Safari só aceita assim.
   */
  async function copySelectionAsPng(): Promise<void> {
    commitText();
    const ids = editor ? [...editor.selectedIds] : [];
    if (!editor || ids.length === 0) return;
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      notice = 'Este navegador não deixa copiar imagens.';
      return;
    }
    try {
      const png = renderer.renderToPng(editor.board, ids, { ...DEFAULT_EXPORT, background });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      showToast('Copiado como PNG');
    } catch (err) {
      console.error(err);
      notice = 'O navegador não deixou copiar a imagem.';
    }
  }

  function duplicateSelected(): void {
    if (editor && editor.duplicateSelection().length > 0) tool = 'select';
  }

  function onDragOver(e: DragEvent): void {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  function onDrop(e: DragEvent): void {
    const files = pickImageFiles(e.dataTransfer?.files);
    if (files.length === 0) return;
    e.preventDefault();
    const rect = canvas?.getBoundingClientRect();
    void addImages(files, { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) });
  }

  // --- Texto -------------------------------------------------------------

  function openText(request: TextRequest): void {
    if (!editor) return;
    const id = request.id;
    editing = {
      ...request,
      value: id ? (editor.board.text(id) ?? '') : '',
      color: id ? (editor.board.strokeColor(id) ?? color) : color,
      fontSize: id ? (editor.board.fontSize(id) ?? DEFAULT_FONT_SIZE) : editor.fontSize,
    };
    requestDraw();
    // Espera o clique terminar: senão o navegador devolve o foco ao canvas e a caixa fecha na hora.
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.select();
    });
  }

  function commitText(): void {
    const current = editing;
    if (!current || !editor) return;
    editing = null;
    editor.commitText({ id: current.id, world: current.world }, current.value, measure(current.value, current.fontSize));
    requestDraw();
  }

  function onTextKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      commitText();
    }
  }

  const textBox = $derived.by(() => {
    if (!editing) return null;
    const at = worldToScreen(camera, editing.world.x, editing.world.y);
    const size = measure(editing.value || ' ', editing.fontSize);
    const fontPx = editing.fontSize * camera.zoom;
    return {
      left: at.x,
      top: at.y,
      width: size.width * camera.zoom + fontPx,
      height: size.height * camera.zoom,
      fontPx,
    };
  });

  // --- Ponteiro, rodinha e teclado ---------------------------------------

  function toInput(e: PointerEvent): PointerInput {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      id: e.pointerId,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pressure,
      button: e.button,
      pointerType: e.pointerType,
      shift: e.shiftKey,
    };
  }

  function onPointerDown(e: PointerEvent): void {
    if (editing) {
      // Clicar fora da caixa de texto só grava o texto; não começa outra coisa.
      commitText();
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    editor?.pointerDown(toInput(e));
    requestDraw();
  }

  function onPointerMove(e: PointerEvent): void {
    if (!editor) return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    lastPointer = { x: e.clientX - box.left, y: e.clientY - box.top };
    if (e.buttons === 0 && e.pointerType === 'mouse') {
      hoverCursor = editor.cursorAt(lastPointer.x, lastPointer.y);
    }
    // Eventos agrupados pelo navegador: sem eles, o traço livre fica com cantos.
    const target = e.currentTarget as HTMLElement;
    const events = e.getCoalescedEvents?.() ?? [e];
    const rect = target.getBoundingClientRect();
    for (const ev of events.length > 0 ? events : [e]) {
      editor.pointerMove({
        id: ev.pointerId,
        x: ev.clientX - rect.left,
        y: ev.clientY - rect.top,
        pressure: ev.pressure,
        button: e.button,
        pointerType: ev.pointerType,
        shift: e.shiftKey,
      });
    }
  }

  function onPointerUp(e: PointerEvent): void {
    editor?.pointerUp(toInput(e));
    requestDraw();
  }

  function onDoubleClick(e: MouseEvent): void {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    editor?.doubleClick(e.clientX - rect.left, e.clientY - rect.top);
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (!editor) return;
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.height : 1;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    editor.wheel(e.clientX - rect.left, e.clientY - rect.top, e.deltaX * scale, e.deltaY * scale, e.ctrlKey || e.metaKey);
  }

  const shortcuts: Record<string, Tool> = {
    v: 'select',
    h: 'hand',
    r: 'rectangle',
    a: 'arrow',
    b: 'figure',
    p: 'pencil',
    t: 'text',
    e: 'eraser',
    '1': 'select',
    '2': 'hand',
    '3': 'rectangle',
    '4': 'arrow',
    '5': 'figure',
    '6': 'pencil',
    '7': 'text',
    '8': 'eraser',
  };

  function onKeyDown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || diagram) return;
    if ((diagramMenu || backgroundMenu) && e.key === 'Escape') {
      diagramMenu = null;
      backgroundMenu = null;
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') {
      e.preventDefault();
      spaceHeld = true;
      if (editor) editor.spaceHeld = true;
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && hasSelection()) {
      e.preventDefault();
      deleteSelected();
    } else if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (mod && !e.shiftKey && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x')) {
      if (copyByKey(e.key.toLowerCase() === 'x')) e.preventDefault();
    } else if (e.shiftKey && e.altKey && e.code === 'KeyC' && hasSelection()) {
      // Shift+Alt+C (no Mac, Alt+Shift+C escreve "Ç": por isso o código da tecla).
      e.preventDefault();
      void copySelectionAsPng();
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      commitText();
      tool = 'select';
      editor?.selectAll();
    } else if (mod && e.key.toLowerCase() === 'd' && hasSelection()) {
      e.preventDefault();
      duplicateSelected();
    } else if (e.key === 'Escape') {
      editor?.select(null);
    } else if (e.key === 'Enter' && editor?.selectedId && editor.board.kind(editor.selectedId) === 'text') {
      e.preventDefault();
      editor.doubleClick(...selectionCenter(editor.selectedId));
    } else if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      editor?.zoomBy(1.2, center());
    } else if (mod && e.key === '-') {
      e.preventDefault();
      editor?.zoomBy(1 / 1.2, center());
    } else if (mod && e.key === '0') {
      e.preventDefault();
      editor?.resetZoom(center());
    } else if (!mod && !e.altKey) {
      const next = shortcuts[e.key.toLowerCase()];
      if (next) selectTool(next);
    }
  }

  /** Centro do elemento em coordenadas de tela (para reaproveitar o clique duplo pelo teclado). */
  function selectionCenter(id: string): [number, number] {
    const b = editor?.board.bounds(id);
    if (!editor || !b) return [0, 0];
    const at = worldToScreen(editor.camera, ((b[0] ?? 0) + (b[2] ?? 0)) / 2, ((b[1] ?? 0) + (b[3] ?? 0)) / 2);
    return [at.x, at.y];
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      spaceHeld = false;
      if (editor) editor.spaceHeld = false;
    }
  }

  onMount(() => {
    let disposed = false;
    const store = new IndexedDbStore();

    const resize = () => {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      view.width = rect.width;
      view.height = rect.height;
      view.dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * view.dpr);
      canvas.height = Math.round(rect.height * view.dpr);
      requestDraw();
    };
    const observer = new ResizeObserver(resize);
    if (canvas) observer.observe(canvas);

    const flush = () => {
      commitText();
      if (!autosaver?.hasPending || !editor) return;
      // Gravação síncrona primeiro: o navegador pode cortar a do IndexedDB no fechamento.
      emergencyBackup.write(editor.board.toJson());
      void autosaver.flush().then(() => {
        if (!autosaver?.hasPending) emergencyBackup.clear();
      });
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush();
      else void drive?.syncNow();
    };
    const syncDrive = () => void drive?.syncNow();
    window.addEventListener('focus', syncDrive);
    window.addEventListener('online', syncDrive);
    const stopGesture = (e: Event) => e.preventDefault();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);
    // Safari no iPad: sem isso, a pinça dá zoom na página em vez do canvas.
    document.addEventListener('gesturestart', stopGesture);

    (async () => {
      // A fonte precisa estar carregada antes de medir ou desenhar texto.
      await Promise.all([loadCore(), document.fonts.load(fontString(DEFAULT_FONT_SIZE)).catch(() => [])]);
      let board = newBoard();
      try {
        // Cópia de emergência de um fechamento com mudança pendente vale mais que o IndexedDB.
        const rescued = emergencyBackup.read();
        if (rescued) {
          await store.save(rescued);
          emergencyBackup.clear();
        }
        const saved = await store.load();
        if (saved) {
          try {
            board.free();
            board = boardFromJson(saved);
          } catch (err) {
            // Não sobrescreve um arquivo que não conseguimos ler: guarda uma cópia antes.
            board = newBoard();
            await store.save(saved, `ilegivel-${Date.now()}`);
            notice = 'O desenho salvo não pôde ser aberto. Uma cópia foi guardada e começamos um novo.';
            console.error(err);
          }
        }
      } catch (err) {
        notice = 'Este navegador não deixou salvar desenhos. O que você fizer agora não vai ficar guardado.';
        console.error(err);
      }
      if (disposed) {
        board.free();
        return;
      }
      editor = new Editor(board, {
        onDocumentChange: () => {
          syncBackground();
          requestDraw();
          autosaver?.schedule();
          canUndo = editor?.canUndo ?? false;
          canRedo = editor?.canRedo ?? false;
          drive?.localChange();
        },
        onRemoteChange: () => {
          syncBackground();
          requestDraw();
          autosaver?.schedule();
        },
        onViewChange: requestDraw,
        onSelectionChange: (ids) => {
          selectedCount = ids.length;
          requestDraw();
        },
        onTextRequest: openText,
      });
      editor.tool = tool;
      editor.ink = { ...editor.ink, color };
      syncBackground();
      autosaver = new Autosaver(store, () => editor?.board.toJson() ?? '', (s) => (status = s));
      requestDraw();
      startDrive();
    })();

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
      document.removeEventListener('gesturestart', stopGesture);
      window.removeEventListener('focus', syncDrive);
      window.removeEventListener('online', syncDrive);
      drive?.dispose();
      flush();
    };
  });
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onKeyDown} onkeyup={onKeyUp} oncopy={onCopy} oncut={onCut} onpaste={onPaste} />

<main ondragover={onDragOver} ondrop={onDrop}>
  <canvas
    bind:this={canvas}
    class="tool-{tool}"
    class:pan={tool === 'hand' || spaceHeld}
    class:panning
    style:cursor={hoverCursor}
    aria-label="Quadro de desenho"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    ondblclick={onDoubleClick}
    onwheel={onWheel}
    onpointerleave={() => (lastPointer = null)}
    oncontextmenu={(e) => e.preventDefault()}
  ></canvas>

  {#if editing && textBox}
    <textarea
      bind:this={textarea}
      bind:value={editing.value}
      class="text-editor"
      aria-label="Texto"
      spellcheck="false"
      autocapitalize="sentences"
      wrap="off"
      style:left="{textBox.left}px"
      style:top="{textBox.top}px"
      style:width="{textBox.width}px"
      style:height="{textBox.height}px"
      style:font-size="{textBox.fontPx}px"
      style:line-height={LINE_HEIGHT}
      style:font-family={FONT_FAMILY}
      style:color={displayInk(editing.color, background)}
      onblur={commitText}
      onkeydown={onTextKeyDown}
    ></textarea>
  {/if}

  <div class="toolbar" role="toolbar" aria-label="Ferramentas">
    {#each tools as t (t.id)}
      <button
        class="tool"
        class:active={tool === t.id}
        aria-pressed={tool === t.id}
        aria-label={t.label}
        title="{t.label} — {t.key}"
        onclick={() => selectTool(t.id)}
      >
        <Icon name={t.icon} />
      </button>
    {/each}
    <button
      class="tool diagram-button"
      class:active={diagramMenu !== null}
      aria-label="Diagrama (Mermaid)"
      aria-haspopup="menu"
      aria-expanded={diagramMenu !== null}
      title="Diagrama (Mermaid)"
      onclick={toggleDiagramMenu}
    >
      <Icon name="diagram" />
    </button>
    <button class="tool" aria-label="Inserir imagem" title="Inserir imagem (ou cole com Ctrl+V)" onclick={() => fileInput?.click()}>
      <Icon name="image" />
    </button>
    <input
      bind:this={fileInput}
      type="file"
      accept={ACCEPTED_TYPES.join(',')}
      multiple
      hidden
      onchange={onFilesChosen}
    />
    <span class="divider" aria-hidden="true"></span>
    {#each INK_COLORS as c (c)}
      <button
        class="swatch"
        class:active={color === c}
        aria-pressed={color === c}
        aria-label="Cor {c}"
        style:--swatch={displayInk(c, background)}
        onclick={() => selectColor(c)}
      ></button>
    {/each}
    <span class="divider" aria-hidden="true"></span>
    <button
      class="tool background-button"
      class:active={backgroundMenu !== null}
      aria-label="Cor do fundo"
      aria-haspopup="menu"
      aria-expanded={backgroundMenu !== null}
      title="Cor do fundo"
      onclick={toggleBackgroundMenu}
    >
      <span class="background-chip" style:--chip={background}></span>
    </button>
    {#if selectedCount > 0}
      <span class="divider" aria-hidden="true"></span>
      <button class="tool" aria-label="Copiar como PNG" title="Copiar como PNG — Shift+Alt+C" onclick={copySelectionAsPng}>
        <Icon name="copyImage" />
      </button>
      <button class="tool" aria-label="Duplicar seleção" title="Duplicar — Ctrl+D" onclick={duplicateSelected}>
        <Icon name="duplicate" />
      </button>
      <button class="tool danger" aria-label="Apagar seleção" title="Apagar — Delete" onclick={deleteSelected}>
        <Icon name="trash" />
      </button>
    {/if}
  </div>

  <div class="zoom" aria-label="Zoom">
    <button title="Diminuir zoom — Ctrl −" onclick={() => editor?.zoomBy(1 / 1.2, center())}>
      <Icon name="minus" size={16} />
    </button>
    <button class="percent" title="Voltar para 100% — Ctrl 0" onclick={() => editor?.resetZoom(center())}>
      {Math.round(camera.zoom * 100)}%
    </button>
    <button title="Aumentar zoom — Ctrl +" onclick={() => editor?.zoomBy(1.2, center())}>
      <Icon name="plus" size={16} />
    </button>
  </div>

  {#if googleClientId}
    <DriveMenu
      status={driveState}
      detail={driveDetail}
      folderUrl={driveFolderUrl}
      onConnect={connectDrive}
      onSync={() => void drive?.syncNow()}
      onDisconnect={() => void drive?.disconnect()}
    />
  {/if}

  <div class="history" aria-label="Histórico">
    <button title="Desfazer — Ctrl+Z" aria-label="Desfazer" disabled={!canUndo} onclick={undo}>
      <Icon name="undo" size={18} />
    </button>
    <button title="Refazer — Ctrl+Shift+Z" aria-label="Refazer" disabled={!canRedo} onclick={redo}>
      <Icon name="redo" size={18} />
    </button>
  </div>

  {#if toast}
    <p class="toast" role="status">{toast}</p>
  {/if}

  <p class="status" class:error={status === 'error'} class:on-dark={isDark(background)} aria-live="polite">{statusText[status]}</p>

  {#if diagramMenu}
    <div class="diagram-menu" role="menu" aria-label="Diagrama" style:left="{diagramMenu.left}px" style:top="{diagramMenu.top}px">
      <button role="menuitem" onclick={() => openDiagram('Diagrama em texto simples', BLANK_PLAIN, 'plain')}>
        <strong>Escrever em texto simples</strong>
        <span>Um passo por linha, sem código</span>
      </button>
      <button role="menuitem" onclick={() => openDiagram('Diagrama em Mermaid', BLANK_DIAGRAM)}>
        <strong>Escrever em Mermaid</strong>
        <span>Começar do zero</span>
      </button>
      <p class="menu-title">Modelos</p>
      {#each TEMPLATES as t (t.id)}
        <button role="menuitem" onclick={() => openDiagram(t.label, t.code)}>
          <strong>{t.label}</strong>
          <span>{t.description}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if backgroundMenu}
    <div
      class="background-menu"
      role="menu"
      aria-label="Cor do fundo"
      style:left="{backgroundMenu.left}px"
      style:top="{backgroundMenu.top}px"
    >
      <p class="menu-title">Fundo</p>
      {#each BACKGROUNDS as b (b.color)}
        <button
          role="menuitemradio"
          aria-checked={background === b.color}
          class:active={background === b.color}
          onclick={() => chooseBackground(b.color)}
        >
          <span class="background-chip" style:--chip={b.color}></span>
          {b.label}
        </button>
      {/each}
    </div>
  {/if}

  {#if diagram}
    <DiagramDialog title={diagram.title} initialCode={diagram.code} initialLanguage={diagram.language} onInsert={insertDiagram} onClose={() => (diagram = null)} />
  {/if}

  {#if notice}
    <div class="notice" role="alert">
      <span>{notice}</span>
      <button onclick={() => (notice = null)}>Entendi</button>
    </div>
  {/if}
</main>

<style>
  main {
    position: relative;
    width: 100%;
    height: 100%;
  }

  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
    cursor: crosshair;
  }

  canvas.tool-select {
    cursor: default;
  }

  canvas.tool-text {
    cursor: text;
  }

  canvas.tool-eraser {
    cursor:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Ccircle cx='10' cy='10' r='8' fill='white' fill-opacity='.6' stroke='%231f2933' stroke-width='1.5'/%3E%3C/svg%3E")
        10 10,
      cell;
  }

  canvas.pan {
    cursor: grab;
  }

  canvas.panning {
    cursor: grabbing;
  }

  .text-editor {
    position: absolute;
    margin: 0;
    padding: 0;
    border: 0;
    outline: 1px dashed var(--accent);
    outline-offset: 4px;
    background: transparent;
    resize: none;
    overflow: hidden;
    white-space: pre;
    min-width: 1ch;
  }

  .toolbar,
  .zoom,
  .history,
  .notice {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }

  .toolbar {
    top: max(12px, env(safe-area-inset-top));
    left: 50%;
    transform: translateX(-50%);
    max-width: calc(100% - 24px);
    overflow-x: auto;
  }

  .tool,
  .zoom button,
  .history button {
    display: grid;
    flex: none;
    place-items: center;
    min-width: 36px;
    height: 36px;
    padding: 0 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    cursor: pointer;
  }

  .tool:hover,
  .zoom button:hover:not(:disabled),
  .history button:hover:not(:disabled) {
    background: #f3f1ec;
  }

  .tool.active {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .tool.danger:hover {
    background: #fde8e8;
    color: #b91c1c;
  }

  .divider {
    flex: none;
    width: 1px;
    height: 24px;
    margin: 0 4px;
    background: var(--panel-border);
  }

  .swatch {
    flex: none;
    width: 24px;
    height: 24px;
    margin: 0 2px;
    padding: 0;
    border: 2px solid var(--panel);
    border-radius: 50%;
    background: var(--swatch);
    box-shadow: 0 0 0 1px var(--panel-border);
    cursor: pointer;
  }

  .swatch.active {
    box-shadow: 0 0 0 2px var(--accent);
  }

  .background-chip {
    display: block;
    width: 20px;
    height: 20px;
    border-radius: 6px;
    background: var(--chip);
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25);
  }

  .background-menu {
    position: absolute;
    z-index: 5;
    display: flex;
    flex-direction: column;
    width: 180px;
    padding: 6px;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }

  .background-menu button {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    font: inherit;
    font-size: 14px;
    text-align: left;
    cursor: pointer;
  }

  .background-menu button:hover,
  .background-menu button:focus-visible {
    background: #f3f1ec;
  }

  .background-menu button.active {
    background: var(--accent-soft);
  }

  .diagram-menu {
    position: absolute;
    z-index: 5;
    display: flex;
    flex-direction: column;
    width: 260px;
    padding: 6px;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }

  .diagram-menu button {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 8px 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .diagram-menu button:hover,
  .diagram-menu button:focus-visible {
    background: #f3f1ec;
  }

  .diagram-menu strong {
    font-size: 14px;
    font-weight: 500;
  }

  .diagram-menu span {
    font-size: 12px;
    color: var(--muted);
  }

  .menu-title {
    margin: 6px 10px 2px;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .zoom {
    left: max(12px, env(safe-area-inset-left));
    bottom: max(12px, env(safe-area-inset-bottom));
    gap: 0;
  }

  .history {
    left: calc(max(12px, env(safe-area-inset-left)) + 152px);
    bottom: max(12px, env(safe-area-inset-bottom));
    gap: 0;
  }

  .history button:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .zoom .percent {
    min-width: 56px;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .toast {
    position: absolute;
    bottom: max(64px, calc(env(safe-area-inset-bottom) + 52px));
    left: 50%;
    transform: translateX(-50%);
    margin: 0;
    padding: 8px 14px;
    border-radius: 999px;
    background: #1f2933;
    color: white;
    font-size: 13px;
    box-shadow: var(--shadow);
    pointer-events: none;
  }

  .status {
    position: absolute;
    right: max(16px, env(safe-area-inset-right));
    bottom: max(18px, env(safe-area-inset-bottom));
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    pointer-events: none;
  }

  .status.on-dark {
    color: rgba(255, 255, 255, 0.6);
  }

  .status.error {
    color: #b91c1c;
  }

  .status.error.on-dark {
    color: #fca5a5;
  }

  .notice {
    top: 72px;
    left: 50%;
    transform: translateX(-50%);
    max-width: min(520px, calc(100% - 32px));
    gap: 12px;
    padding: 10px 12px;
    font-size: 14px;
  }

  .notice button {
    flex: none;
    padding: 6px 10px;
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    background: var(--paper);
    cursor: pointer;
  }

  @media (max-width: 520px) {
    .status {
      display: none;
    }
  }
</style>
