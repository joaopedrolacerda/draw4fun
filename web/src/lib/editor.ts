// Interação com o canvas, sem DOM: recebe ponteiros e rodinha já em coordenadas de tela
// (relativas ao canvas) e traduz em mudanças no desenho (núcleo em Rust) ou na câmera.
// Assim dá para testar tudo no Vitest, com o WASM de verdade.

import type { Board } from './core';
import { type Camera, type Vec, initialCamera, panBy, screenToWorld, worldToScreen, zoomAt } from './camera';
import { HANDLES, type Handle, type Rect, containsRect, corner, elementRect, groupFrame, groupRect, opposite, rectFrom } from './selection';
import { type LoadedImage, placeImage } from './images';
import { DEFAULT_FONT_SIZE, type TextSize } from './text';

export type Tool = 'select' | 'hand' | 'rectangle' | 'arrow' | 'figure' | 'pencil' | 'text' | 'eraser';

export interface PointerInput {
  id: number;
  x: number;
  y: number;
  /** 0 a 1. Mouse informa 0,5 com botão apertado; caneta informa a pressão real. */
  pressure: number;
  /** 0 = principal, 1 = do meio, 2 = direito. */
  button: number;
  pointerType: 'mouse' | 'pen' | 'touch' | string;
  /** Shift apertado: ao redimensionar, mantém a proporção; ao clicar, soma ou tira da seleção. */
  shift?: boolean;
}

export interface Ink {
  color: string;
  width: number;
  roughness: number;
}

/** Pedido para abrir a caixa de texto: novo texto em `world`, ou edição do texto `id`. */
export interface TextRequest {
  world: Vec;
  id?: string;
}

export const INK_COLORS = ['#1f2933', '#c2410c', '#1d4ed8', '#15803d'] as const;

/** Formas menores que isso (em pixels de tela) foram um clique sem querer e são descartadas. */
const MIN_SHAPE_SIZE = 3;
/** Boneco feito com um clique só (sem arrastar), em unidades do mundo. */
export const FIGURE_SIZE = { width: 44, height: 80 } as const;
/** Folga do clique de seleção, em pixels de tela. */
const HIT_TOLERANCE = 6;
/** Raio da borracha, em pixels de tela. */
const ERASER_RADIUS = 8;
/** Passo entre amostras da borracha, para não pular elementos num gesto rápido. */
const ERASER_STEP = 4;
/** Alcance do clique numa alça, em pixels de tela. Dedo precisa de mais folga que mouse. */
const HANDLE_HIT = { mouse: 10, touch: 18 };

type Gesture =
  | { kind: 'idle' }
  | { kind: 'pan'; pointer: number; last: Vec }
  | { kind: 'box'; shape: 'rectangle' | 'figure'; pointer: number; id: string; start: Vec; startScreen: Vec }
  | { kind: 'arrow'; pointer: number; id: string; startScreen: Vec }
  | { kind: 'pencil'; pointer: number; id: string }
  | { kind: 'move'; pointer: number; ids: string[]; last: Vec }
  | {
      kind: 'marquee';
      pointer: number;
      start: Vec;
      current: Vec;
      startScreen: Vec;
      /** Seleção de antes (com Shift, a caixa soma a ela). */
      base: string[];
    }
  | { kind: 'erase'; pointer: number; last: Vec }
  | {
      kind: 'resize';
      pointer: number;
      /** Limites de cada elemento no começo do gesto. */
      items: { id: string; rect: Rect }[];
      /** Limites do conjunto no começo do gesto. */
      from: Rect;
      /** Canto oposto à alça: fica parado. */
      anchor: Vec;
      /** Diferença entre o canto do conjunto e o ponto onde a alça foi pega. */
      grab: Vec;
      keepAspect: boolean;
    }
  | { kind: 'pinch'; startDistance: number; startZoom: number; anchor: Vec };

export interface EditorEvents {
  /** O desenho mudou: hora de redesenhar e de salvar. */
  onDocumentChange?: () => void;
  /** Só a vista mudou (zoom, arrasto): redesenhar, sem salvar. */
  onViewChange?: () => void;
  onSelectionChange?: (ids: readonly string[]) => void;
  /** A interface deve abrir a caixa de texto. */
  onTextRequest?: (request: TextRequest) => void;
  /**
   * O desenho mudou por causa de outro aparelho (sincronização): redesenhar e salvar,
   * mas não marcar como mudança local a enviar. Sem este, cai em `onDocumentChange`.
   */
  onRemoteChange?: () => void;
}

export class Editor {
  camera: Camera = initialCamera();
  ink: Ink = { color: INK_COLORS[0], width: 2, roughness: 1 };
  fontSize = DEFAULT_FONT_SIZE;
  /** Espaço apertado: qualquer ferramenta vira mão, como em editores de desenho. */
  spaceHeld = false;

  private currentTool: Tool = 'pencil';
  /** Selecionados, na ordem em que entraram na seleção. */
  private selection: string[] = [];
  private gesture: Gesture = { kind: 'idle' };
  private pointers = new Map<number, Vec>();

  constructor(
    public board: Board,
    private events: EditorEvents = {},
  ) {}

  get tool(): Tool {
    return this.currentTool;
  }

  /** Trocar de ferramenta desfaz a seleção, a não ser que seja para a própria seleção. */
  set tool(tool: Tool) {
    this.currentTool = tool;
    if (tool !== 'select') this.select(null);
  }

  /** Todos os selecionados. */
  get selectedIds(): readonly string[] {
    return this.selection;
  }

  /** O selecionado, quando há exatamente um (para editar texto, por exemplo). */
  get selectedId(): string | null {
    return this.selection.length === 1 ? (this.selection[0] ?? null) : null;
  }

  /** Retângulo da seleção por caixa em andamento (no mundo), para o renderer desenhar. */
  get marquee(): Rect | null {
    const g = this.gesture;
    return g.kind === 'marquee' ? rectFrom(g.start, g.current) : null;
  }

  get isPanning(): boolean {
    return this.gesture.kind === 'pan' || this.gesture.kind === 'pinch';
  }

  select(id: string | null): void {
    this.setSelection(id ? [id] : []);
  }

  /** Troca a seleção inteira (repetidos e inexistentes ficam de fora). */
  setSelection(ids: readonly string[]): void {
    const visible = new Set(this.board.visibleIds());
    const next = [...new Set(ids)].filter((id) => visible.has(id));
    if (next.length === this.selection.length && next.every((id, i) => id === this.selection[i])) return;
    this.selection = next;
    this.events.onSelectionChange?.(next);
  }

  /** Seleciona tudo o que está no quadro (Ctrl/Cmd+A). */
  /** Cor de fundo do quadro, ou `undefined` para o padrão. */
  get background(): string | undefined {
    return this.board.background();
  }

  /** Troca a cor de fundo. Vai para o arquivo e para o Drive, mas não para o desfazer. */
  setBackground(color: string): void {
    if (this.board.setBackground(color)) this.events.onDocumentChange?.();
  }

  selectAll(): void {
    this.currentTool = 'select';
    this.setSelection(this.board.visibleIds());
  }

  /** Tira da seleção o que não existe mais (apagado, desfeito, apagado em outro aparelho). */
  private pruneSelection(): void {
    this.setSelection(this.selection);
  }

  /** Troca o desenho aberto (por exemplo, ao carregar do armazenamento). */
  replaceBoard(board: Board): void {
    this.board.free();
    this.board = board;
    this.gesture = { kind: 'idle' };
    this.select(null);
    this.events.onDocumentChange?.();
  }

  /** Apaga os selecionados. Devolve `false` se não havia seleção. */
  deleteSelected(): boolean {
    const ids = this.selection;
    if (ids.length === 0) return false;
    for (const id of ids) this.board.remove(id);
    this.select(null);
    this.board.endStep();
    this.events.onDocumentChange?.();
    return true;
  }

  /**
   * Põe uma imagem no quadro, centrada em `centerScreen` e ocupando no máximo `fraction`
   * da tela, e já deixa selecionada (com a
   * ferramenta de seleção) para poder mover e redimensionar em seguida.
   */
  insertImage(image: LoadedImage, centerScreen: Vec, viewport: { width: number; height: number }, fraction = 0.5): string {
    const r = placeImage(image, centerScreen, this.camera, viewport, fraction);
    const id = this.board.addImage(
      r.minX,
      r.minY,
      r.maxX - r.minX,
      r.maxY - r.minY,
      image.fileId,
      image.mimeType,
      image.dataUrl,
    );
    this.currentTool = 'select';
    this.select(id);
    this.board.endStep();
    this.events.onDocumentChange?.();
    return id;
  }

  /** Alça de redimensionar da seleção sob o ponto da tela, se houver. */
  handleAt(sx: number, sy: number, pointerType = 'mouse'): Handle | null {
    if (this.selection.length === 0) return null;
    const frame = groupFrame(this.board, this.selection, this.camera.zoom);
    if (!frame) return null;
    const reach = pointerType === 'touch' ? HANDLE_HIT.touch : HANDLE_HIT.mouse;
    for (const h of HANDLES) {
      const c = corner(frame, h);
      const s = worldToScreen(this.camera, c.x, c.y);
      if (Math.abs(s.x - sx) <= reach && Math.abs(s.y - sy) <= reach) return h;
    }
    return null;
  }

  /** Junta uma cópia do desenho vinda de outro aparelho. Lança erro se não conseguir ler. */
  mergeRemote(json: string): void {
    this.board.mergeRemote(json);
    this.pruneSelection();
    (this.events.onRemoteChange ?? this.events.onDocumentChange)?.();
  }

  get canUndo(): boolean {
    return this.board.canUndo();
  }

  get canRedo(): boolean {
    return this.board.canRedo();
  }

  /** Desfaz o último passo. No meio de um gesto não faz nada, para não brigar com ele. */
  undo(): boolean {
    return this.travel(() => this.board.undo());
  }

  redo(): boolean {
    return this.travel(() => this.board.redo());
  }

  private travel(move: () => boolean): boolean {
    if (this.gesture.kind !== 'idle' || !move()) return false;
    // Algum selecionado pode ter sumido (desfez a criação dele).
    this.pruneSelection();
    this.events.onDocumentChange?.();
    return true;
  }

  /** Fecha o passo do histórico ao fim de um gesto. Avisa a interface se entrou algo. */
  private finishStep(): void {
    if (this.board.endStep()) this.events.onDocumentChange?.();
  }

  /** Conteúdo para a área de transferência com os selecionados, ou `null` sem seleção. */
  copySelection(): string | null {
    return this.selection.length > 0 ? this.board.copy([...this.selection]) : null;
  }

  /** Copia e apaga os selecionados. */
  cutSelection(): string | null {
    const json = this.copySelection();
    if (json) this.deleteSelected();
    return json;
  }

  /**
   * Cola o que foi copiado do draw4fun. Com `atScreen`, centra ali; sem, põe ao lado do
   * original. Lança erro se o conteúdo não for do draw4fun.
   */
  paste(json: string, atScreen: Vec | null): string[] {
    const at = atScreen ? screenToWorld(this.camera, atScreen.x, atScreen.y) : null;
    return this.afterInsert(this.board.paste(json, at?.x, at?.y));
  }

  /** Duplica os selecionados ao lado dos originais. */
  duplicateSelection(): string[] {
    return this.selection.length > 0 ? this.afterInsert(this.board.duplicate([...this.selection])) : [];
  }

  /** Cola um texto comum (não do draw4fun) como elemento de texto, começando em `atScreen`. */
  pasteText(text: string, atScreen: Vec, size: TextSize): string | null {
    const id = this.commitText({ world: screenToWorld(this.camera, atScreen.x, atScreen.y) }, text, size);
    if (id) this.afterInsert([id]);
    return id;
  }

  /** Depois de inserir: seleção com tudo o que entrou, para mover ou redimensionar em seguida. */
  private afterInsert(ids: string[]): string[] {
    if (ids.length > 0) {
      this.currentTool = 'select';
      this.setSelection(ids);
      this.board.endStep();
      this.events.onDocumentChange?.();
    }
    return ids;
  }

  /** Texto sob o ponto da tela, se houver. */
  textAt(sx: number, sy: number): string | null {
    const w = screenToWorld(this.camera, sx, sy);
    const id = this.board.hitTest(w.x, w.y, HIT_TOLERANCE / this.camera.zoom);
    return id && this.board.kind(id) === 'text' ? id : null;
  }

  /**
   * Grava o que foi digitado na caixa de texto. Texto vazio não cria nada, e esvaziar
   * um texto que já existia apaga o texto. Devolve o id do texto, se sobrou algum.
   */
  commitText(request: TextRequest, value: string, size: TextSize): string | null {
    const empty = value.trim().length === 0;
    if (request.id) {
      if (empty) {
        this.board.remove(request.id);
        this.pruneSelection();
        this.board.endStep();
        this.events.onDocumentChange?.();
        return null;
      }
      if (value !== this.board.text(request.id)) {
        this.board.setText(request.id, value, size.width, size.height);
        this.board.endStep();
        this.events.onDocumentChange?.();
      }
      return request.id;
    }
    if (empty) return null;
    const id = this.board.addText(
      request.world.x,
      request.world.y,
      value,
      this.fontSize,
      size.width,
      size.height,
      this.ink.color,
    );
    this.board.endStep();
    this.events.onDocumentChange?.();
    return id;
  }

  /** Clique duplo: edita o texto sob o cursor; na seleção, em lugar vazio, começa um texto novo. */
  doubleClick(sx: number, sy: number): void {
    const id = this.textAt(sx, sy);
    if (id) {
      this.requestTextEdit(id);
    } else if (this.currentTool === 'select') {
      this.events.onTextRequest?.({ world: screenToWorld(this.camera, sx, sy) });
    }
  }

  pointerDown(p: PointerInput): void {
    this.pointers.set(p.id, { x: p.x, y: p.y });

    if (p.pointerType === 'touch' && this.pointers.size === 2) {
      this.startPinch();
      return;
    }
    if (this.gesture.kind !== 'idle') return;

    const wantsPan = this.currentTool === 'hand' || this.spaceHeld || p.button === 1;
    if (wantsPan) {
      this.gesture = { kind: 'pan', pointer: p.id, last: { x: p.x, y: p.y } };
      return;
    }
    if (p.button !== 0) return;

    const w = screenToWorld(this.camera, p.x, p.y);
    switch (this.currentTool) {
      case 'select': {
        const handle = this.handleAt(p.x, p.y, p.pointerType);
        if (handle) {
          this.startResize(p, handle, w);
          return;
        }
        const hit = this.board.hitTest(w.x, w.y, HIT_TOLERANCE / this.camera.zoom) ?? null;
        if (!hit) {
          // Lugar vazio: começa a seleção por caixa (com Shift, soma à seleção atual).
          const base = p.shift ? [...this.selection] : [];
          this.setSelection(base);
          this.gesture = { kind: 'marquee', pointer: p.id, start: w, current: w, startScreen: { x: p.x, y: p.y }, base };
          return;
        }
        if (p.shift) {
          // Shift+clique: tira se já estava, põe se não estava.
          const has = this.selection.includes(hit);
          this.setSelection(has ? this.selection.filter((id) => id !== hit) : [...this.selection, hit]);
          if (has) return;
        } else if (!this.selection.includes(hit)) {
          this.select(hit);
        }
        // Arrastar qualquer selecionado leva a seleção inteira junto.
        this.gesture = { kind: 'move', pointer: p.id, ids: [...this.selection], last: w };
        return;
      }
      case 'eraser':
        this.gesture = { kind: 'erase', pointer: p.id, last: { x: p.x, y: p.y } };
        this.eraseAt(p.x, p.y);
        return;
      case 'text': {
        const existing = this.textAt(p.x, p.y);
        if (existing) this.requestTextEdit(existing);
        else this.events.onTextRequest?.({ world: w });
        return;
      }
      case 'rectangle':
      case 'figure': {
        const { color, width, roughness } = this.ink;
        const id =
          this.currentTool === 'rectangle'
            ? this.board.addRectangle(w.x, w.y, 0, 0, color, width, roughness)
            : this.board.addFigure(w.x, w.y, 0, 0, color, width, roughness);
        this.gesture = { kind: 'box', shape: this.currentTool, pointer: p.id, id, start: w, startScreen: { x: p.x, y: p.y } };
        break;
      }
      case 'arrow': {
        const id = this.board.addArrow(w.x, w.y, w.x, w.y, this.ink.color, this.ink.width, this.ink.roughness);
        this.gesture = { kind: 'arrow', pointer: p.id, id, startScreen: { x: p.x, y: p.y } };
        break;
      }
      case 'pencil': {
        const id = this.board.addFreehand(w.x, w.y, pressureOf(p), this.ink.color, this.ink.width);
        this.gesture = { kind: 'pencil', pointer: p.id, id };
        break;
      }
      case 'hand':
        return;
    }
    this.events.onDocumentChange?.();
  }

  pointerMove(p: PointerInput): void {
    if (!this.pointers.has(p.id)) return;
    this.pointers.set(p.id, { x: p.x, y: p.y });
    const g = this.gesture;

    if (g.kind === 'pinch') {
      this.updatePinch();
      return;
    }
    if (g.kind === 'idle' || g.pointer !== p.id) return;

    switch (g.kind) {
      case 'pan':
        this.camera = panBy(this.camera, p.x - g.last.x, p.y - g.last.y);
        g.last = { x: p.x, y: p.y };
        this.events.onViewChange?.();
        return;
      case 'box': {
        const w = screenToWorld(this.camera, p.x, p.y);
        this.board.setFrame(g.id, g.start.x, g.start.y, w.x - g.start.x, w.y - g.start.y);
        this.events.onDocumentChange?.();
        return;
      }
      case 'arrow': {
        const w = screenToWorld(this.camera, p.x, p.y);
        this.board.setArrowEnd(g.id, w.x, w.y);
        this.events.onDocumentChange?.();
        return;
      }
      case 'pencil': {
        const w = screenToWorld(this.camera, p.x, p.y);
        if (this.board.pushPoint(g.id, w.x, w.y, pressureOf(p))) this.events.onDocumentChange?.();
        return;
      }
      case 'move': {
        const w = screenToWorld(this.camera, p.x, p.y);
        for (const id of g.ids) this.board.translate(id, w.x - g.last.x, w.y - g.last.y);
        g.last = w;
        this.events.onDocumentChange?.();
        return;
      }
      case 'marquee': {
        g.current = screenToWorld(this.camera, p.x, p.y);
        const area = rectFrom(g.start, g.current);
        // Entra o que estiver inteiro dentro da caixa.
        const inside = this.board.visibleIds().filter((id) => {
          const r = elementRect(this.board, id);
          return r !== null && containsRect(area, r);
        });
        this.setSelection([...g.base, ...inside]);
        this.events.onViewChange?.();
        return;
      }
      case 'resize': {
        const w = screenToWorld(this.camera, p.x, p.y);
        let dx = w.x + g.grab.x - g.anchor.x;
        let dy = w.y + g.grab.y - g.anchor.y;
        const width = g.from.maxX - g.from.minX;
        const height = g.from.maxY - g.from.minY;
        if ((g.keepAspect || p.shift) && width > 0 && height > 0) {
          const s = Math.max(Math.abs(dx) / width, Math.abs(dy) / height);
          dx = (dx < 0 ? -1 : 1) * width * s;
          dy = (dy < 0 ? -1 : 1) * height * s;
        }
        const to = rectFrom(g.anchor, { x: g.anchor.x + dx, y: g.anchor.y + dy });
        // Cada elemento é esticado na mesma proporção do conjunto, mantendo a posição relativa.
        const ratio = (next: number, prev: number) => (prev > 0 ? next / prev : 1);
        const sx = ratio(to.maxX - to.minX, width);
        const sy = ratio(to.maxY - to.minY, height);
        for (const { id, rect: r } of g.items) {
          this.board.resize(
            id,
            to.minX + (r.minX - g.from.minX) * sx,
            to.minY + (r.minY - g.from.minY) * sy,
            to.minX + (r.maxX - g.from.minX) * sx,
            to.minY + (r.maxY - g.from.minY) * sy,
          );
        }
        this.events.onDocumentChange?.();
        return;
      }
      case 'erase': {
        const steps = Math.max(1, Math.ceil(Math.hypot(p.x - g.last.x, p.y - g.last.y) / ERASER_STEP));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          this.eraseAt(g.last.x + (p.x - g.last.x) * t, g.last.y + (p.y - g.last.y) * t);
        }
        g.last = { x: p.x, y: p.y };
        return;
      }
    }
  }

  pointerUp(p: PointerInput): void {
    const g = this.gesture;
    this.pointers.delete(p.id);
    if ((g.kind === 'box' || g.kind === 'arrow') && g.pointer === p.id) {
      const tiny = Math.abs(p.x - g.startScreen.x) < MIN_SHAPE_SIZE && Math.abs(p.y - g.startScreen.y) < MIN_SHAPE_SIZE;
      if (tiny && g.kind === 'box' && g.shape === 'figure') {
        // Um clique só põe um boneco de tamanho padrão centrado no clique.
        const { width, height } = FIGURE_SIZE;
        this.board.setFrame(g.id, g.start.x - width / 2, g.start.y - height / 2, width, height);
        this.events.onDocumentChange?.();
      } else if (tiny) {
        this.board.remove(g.id);
        this.events.onDocumentChange?.();
      }
    }
    if (g.kind === 'pinch') {
      // Ao tirar um dos dedos, só termina quando os dois saírem: evita um risco acidental.
      if (this.pointers.size === 0) {
        this.gesture = { kind: 'idle' };
        this.finishStep();
      }
      return;
    }
    if ('pointer' in g && g.pointer === p.id) {
      this.gesture = { kind: 'idle' };
      this.finishStep();
    }
  }

  pointerCancel(p: PointerInput): void {
    this.pointerUp(p);
  }

  /**
   * Rodinha e trackpad: rolar arrasta a vista; com Ctrl/Cmd (ou pinça no trackpad,
   * que o navegador entrega como Ctrl + rodinha) dá zoom em torno do cursor.
   */
  wheel(sx: number, sy: number, dx: number, dy: number, zoomModifier: boolean): void {
    if (zoomModifier) {
      this.camera = zoomAt(this.camera, sx, sy, this.camera.zoom * Math.exp(-dy * 0.01));
    } else {
      this.camera = panBy(this.camera, -dx, -dy);
    }
    this.events.onViewChange?.();
  }

  /** Zoom pelos botões ou pelo teclado, em torno do centro da tela. */
  zoomBy(factor: number, center: Vec): void {
    this.camera = zoomAt(this.camera, center.x, center.y, this.camera.zoom * factor);
    this.events.onViewChange?.();
  }

  resetZoom(center: Vec): void {
    this.camera = zoomAt(this.camera, center.x, center.y, 1);
    this.events.onViewChange?.();
  }

  private startResize(p: PointerInput, handle: Handle, w: Vec): void {
    const items = this.selection.flatMap((id) => {
      const rect = elementRect(this.board, id);
      return rect ? [{ id, rect }] : [];
    });
    const from = groupRect(this.board, this.selection);
    if (!from || items.length === 0) return;
    const grabbed = corner(from, handle);
    const only = items.length === 1 ? this.board.kind(items[0]?.id ?? '') : null;
    this.gesture = {
      kind: 'resize',
      pointer: p.id,
      items,
      from,
      anchor: corner(from, opposite(handle)),
      grab: { x: grabbed.x - w.x, y: grabbed.y - w.y },
      // Texto e imagem só crescem por igual: esticar só para um lado deformaria. Um grupo
      // também, para os elementos dele não se deformarem cada um de um jeito.
      keepAspect: items.length > 1 || only === 'text' || only === 'image',
    };
  }

  private requestTextEdit(id: string): void {
    const b = this.board.bounds(id);
    this.events.onTextRequest?.({ id, world: { x: b?.[0] ?? 0, y: b?.[1] ?? 0 } });
  }

  private eraseAt(sx: number, sy: number): void {
    const w = screenToWorld(this.camera, sx, sy);
    const hit = this.board.hitTest(w.x, w.y, ERASER_RADIUS / this.camera.zoom);
    if (!hit) return;
    this.board.remove(hit);
    this.pruneSelection();
    this.events.onDocumentChange?.();
  }

  private startPinch(): void {
    // O primeiro dedo pode ter começado um traço: era o começo do gesto, não um desenho.
    const g = this.gesture;
    if (g.kind === 'box' || g.kind === 'arrow' || g.kind === 'pencil') {
      this.board.remove(g.id);
      this.events.onDocumentChange?.();
    }
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    const mid = midpoint(a, b);
    this.gesture = {
      kind: 'pinch',
      startDistance: Math.max(1, distance(a, b)),
      startZoom: this.camera.zoom,
      anchor: screenToWorld(this.camera, mid.x, mid.y),
    };
  }

  private updatePinch(): void {
    const g = this.gesture;
    const [a, b] = [...this.pointers.values()];
    if (g.kind !== 'pinch' || !a || !b) return;
    const mid = midpoint(a, b);
    const zoom = g.startZoom * (distance(a, b) / g.startDistance);
    // Primeiro aplica o zoom, depois desloca para o ponto do mundo do início ficar sob os dedos.
    const zoomed = zoomAt(this.camera, mid.x, mid.y, zoom);
    this.camera = { x: g.anchor.x - mid.x / zoomed.zoom, y: g.anchor.y - mid.y / zoomed.zoom, zoom: zoomed.zoom };
    this.events.onViewChange?.();
  }
}

function pressureOf(p: PointerInput): number {
  // Mouse e dedo não têm pressão real: usam o meio.
  return p.pointerType === 'pen' && p.pressure > 0 ? p.pressure : 0.5;
}

const distance = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
