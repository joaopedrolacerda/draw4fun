import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isClipboard, newBoard, type Board } from './core';
import { Editor, type PointerInput } from './editor';

const mouse = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput => ({
  id: 1,
  x,
  y,
  pressure: 0.5,
  button: 0,
  pointerType: 'mouse',
  ...extra,
});

const finger = (id: number, x: number, y: number): PointerInput => ({
  id,
  x,
  y,
  pressure: 0.5,
  button: 0,
  pointerType: 'touch',
});

function rectOf(board: Board, id: string) {
  const doc = JSON.parse(board.toJson()) as { elements: { id: string; x: number; y: number; width: number; height: number }[] };
  return doc.elements.find((e) => e.id === id);
}

describe('Editor', () => {
  let editor: Editor;
  const onDocumentChange = vi.fn();
  const onViewChange = vi.fn();

  beforeEach(() => {
    onDocumentChange.mockClear();
    onViewChange.mockClear();
    editor = new Editor(newBoard(), { onDocumentChange, onViewChange });
  });

  afterEach(() => editor.board.free());

  it('retângulo: arrastar cria e solta mantém', () => {
    editor.tool = 'rectangle';
    editor.pointerDown(mouse(10, 10));
    editor.pointerMove(mouse(60, 40));
    editor.pointerUp(mouse(60, 40));
    const [id] = editor.board.visibleIds();
    expect(id).toBeDefined();
    expect(rectOf(editor.board, id ?? '')).toMatchObject({ x: 10, y: 10, width: 50, height: 30 });
    expect(onDocumentChange).toHaveBeenCalled();
  });

  it('retângulo respeita a câmera (zoom e deslocamento)', () => {
    editor.tool = 'rectangle';
    editor.camera = { x: 100, y: 100, zoom: 2 };
    editor.pointerDown(mouse(0, 0));
    editor.pointerMove(mouse(40, 20));
    editor.pointerUp(mouse(40, 20));
    const [id] = editor.board.visibleIds();
    expect(rectOf(editor.board, id ?? '')).toMatchObject({ x: 100, y: 100, width: 20, height: 10 });
  });

  it('clique sem arrastar não deixa retângulo', () => {
    editor.tool = 'rectangle';
    editor.pointerDown(mouse(10, 10));
    editor.pointerUp(mouse(11, 11));
    expect(editor.board.visibleIds()).toEqual([]);
  });

  it('lápis acumula pontos num traço só', () => {
    editor.tool = 'pencil';
    editor.pointerDown(mouse(0, 0));
    for (let i = 1; i <= 10; i++) editor.pointerMove(mouse(i * 5, i * 2));
    editor.pointerUp(mouse(50, 20));
    const doc = JSON.parse(editor.board.toJson()) as { elements: { type: string; points: unknown[] }[] };
    expect(doc.elements).toHaveLength(1);
    expect(doc.elements[0]?.type).toBe('freehand');
    expect(doc.elements[0]?.points).toHaveLength(11);
  });

  it('caneta grava a pressão; mouse usa o meio', () => {
    editor.pointerDown(mouse(0, 0, { pointerType: 'pen', pressure: 0.9 }));
    editor.pointerUp(mouse(0, 0));
    editor.pointerDown(mouse(10, 10, { pressure: 1 }));
    editor.pointerUp(mouse(10, 10));
    const doc = JSON.parse(editor.board.toJson()) as { elements: { points: { pressure: number }[] }[] };
    expect(doc.elements[0]?.points[0]?.pressure).toBeCloseTo(0.9);
    expect(doc.elements[1]?.points[0]?.pressure).toBe(0.5);
  });

  it('mão arrasta a vista sem mexer no desenho', () => {
    editor.tool = 'hand';
    editor.pointerDown(mouse(100, 100));
    editor.pointerMove(mouse(150, 120));
    editor.pointerUp(mouse(150, 120));
    expect(editor.camera).toEqual({ x: -50, y: -20, zoom: 1 });
    expect(editor.board.visibleIds()).toEqual([]);
    expect(onViewChange).toHaveBeenCalled();
    expect(onDocumentChange).not.toHaveBeenCalled();
  });

  it('espaço apertado vira mão com qualquer ferramenta', () => {
    editor.tool = 'pencil';
    editor.spaceHeld = true;
    editor.pointerDown(mouse(0, 0));
    editor.pointerMove(mouse(10, 0));
    editor.pointerUp(mouse(10, 0));
    expect(editor.camera.x).toBe(-10);
    expect(editor.board.visibleIds()).toEqual([]);
  });

  it('botão do meio do mouse arrasta a vista', () => {
    editor.pointerDown(mouse(0, 0, { button: 1 }));
    editor.pointerMove(mouse(0, 30, { button: 1 }));
    expect(editor.camera.y).toBe(-30);
  });

  it('rodinha arrasta; com Ctrl dá zoom em torno do cursor', () => {
    editor.wheel(0, 0, 0, 40, false);
    expect(editor.camera.y).toBe(40);
    editor.camera = { x: 0, y: 0, zoom: 1 };
    editor.wheel(200, 100, 0, -100, true);
    expect(editor.camera.zoom).toBeGreaterThan(1);
    expect(editor.camera.x * editor.camera.zoom + 200).toBeCloseTo(200 * editor.camera.zoom);
  });

  it('pinça com dois dedos dá zoom e descarta o risco do primeiro dedo', () => {
    editor.tool = 'pencil';
    editor.pointerDown(finger(1, 100, 100));
    editor.pointerMove(finger(1, 102, 100));
    editor.pointerDown(finger(2, 202, 100));
    editor.pointerMove(finger(2, 302, 100));
    expect(editor.camera.zoom).toBeCloseTo(2);
    expect(editor.board.visibleIds()).toEqual([]);
    editor.pointerUp(finger(1, 100, 100));
    editor.pointerMove(finger(2, 310, 100));
    editor.pointerUp(finger(2, 310, 100));
    // Depois da pinça, um toque novo volta a desenhar.
    editor.pointerDown(finger(3, 50, 50));
    editor.pointerUp(finger(3, 50, 50));
    expect(editor.board.visibleIds()).toHaveLength(1);
  });

  it('cor da tinta vai para o elemento', () => {
    editor.ink = { ...editor.ink, color: '#1d4ed8' };
    editor.pointerDown(mouse(0, 0));
    editor.pointerUp(mouse(0, 0));
    const [id] = editor.board.visibleIds();
    expect(editor.board.strokeColor(id ?? '')).toBe('#1d4ed8');
  });

  describe('seta e boneco', () => {
    const shapeOf = (id: string) =>
      (JSON.parse(editor.board.toJson()) as { elements: Record<string, unknown>[] }).elements.find((e) => e.id === id);

    it('seta: arrastar vai do ponto inicial até a ponta', () => {
      editor.tool = 'arrow';
      editor.pointerDown(mouse(10, 10));
      editor.pointerMove(mouse(80, 30));
      editor.pointerUp(mouse(80, 30));
      const [id] = editor.board.visibleIds();
      expect(shapeOf(id ?? '')).toMatchObject({ type: 'arrow', points: [[10, 10], [80, 30]] });
      expect(editor.canUndo).toBe(true);
    });

    it('seta sem arrastar é descartada', () => {
      editor.tool = 'arrow';
      editor.pointerDown(mouse(10, 10));
      editor.pointerUp(mouse(11, 10));
      expect(editor.board.visibleIds()).toEqual([]);
    });

    it('boneco: arrastar define a caixa; clique põe um de tamanho padrão no lugar', () => {
      editor.tool = 'figure';
      editor.pointerDown(mouse(100, 100));
      editor.pointerMove(mouse(140, 180));
      editor.pointerUp(mouse(140, 180));
      editor.pointerDown(mouse(300, 300));
      editor.pointerUp(mouse(300, 300));
      const [dragged, clicked] = editor.board.visibleIds();
      expect(shapeOf(dragged ?? '')).toMatchObject({ type: 'figure', x: 100, y: 100, width: 40, height: 80 });
      expect(editor.board.bounds(clicked ?? '')).toEqual(new Float64Array([278, 260, 322, 340]));
    });

    it('seleciona, move e redimensiona como os outros', () => {
      editor.tool = 'figure';
      editor.pointerDown(mouse(0, 0));
      editor.pointerMove(mouse(40, 80));
      editor.pointerUp(mouse(40, 80));
      editor.tool = 'select';
      editor.pointerDown(mouse(20, 40));
      editor.pointerMove(mouse(30, 50));
      editor.pointerUp(mouse(30, 50));
      const [id] = editor.board.visibleIds();
      expect(editor.selectedId).toBe(id);
      expect(editor.board.bounds(id ?? '')).toEqual(new Float64Array([10, 10, 50, 90]));
    });
  });

  describe('seleção', () => {
    it('clique na borda seleciona; clique no vazio desfaz', () => {
      const onSelectionChange = vi.fn();
      editor = new Editor(editor.board, { onSelectionChange });
      const r = editor.board.addRectangle(0, 0, 100, 50, '#000', 2, 1);
      editor.tool = 'select';
      editor.pointerDown(mouse(50, 1));
      editor.pointerUp(mouse(50, 1));
      expect(editor.selectedId).toBe(r);
      editor.pointerDown(mouse(500, 500));
      editor.pointerUp(mouse(500, 500));
      expect(editor.selectedId).toBeNull();
      expect(onSelectionChange.mock.calls).toEqual([[r], [null]]);
    });

    it('arrastar o selecionado move o elemento', () => {
      const r = editor.board.addRectangle(0, 0, 100, 50, '#000', 2, 1);
      editor.tool = 'select';
      editor.pointerDown(mouse(0, 25));
      editor.pointerMove(mouse(30, 45));
      editor.pointerUp(mouse(30, 45));
      expect(rectOf(editor.board, r)).toMatchObject({ x: 30, y: 20, width: 100, height: 50 });
    });

    it('apagar o selecionado tira do quadro e desfaz a seleção', () => {
      const r = editor.board.addRectangle(0, 0, 100, 50, '#000', 2, 1);
      editor.tool = 'select';
      editor.pointerDown(mouse(50, 0));
      editor.pointerUp(mouse(50, 0));
      expect(editor.deleteSelected()).toBe(true);
      expect(editor.board.visibleIds()).toEqual([]);
      expect(editor.selectedId).toBeNull();
      expect(editor.deleteSelected()).toBe(false);
      expect(editor.board.kind(r)).toBe('rectangle'); // continua no arquivo, marcado como apagado
    });

    it('trocar de ferramenta desfaz a seleção', () => {
      const r = editor.board.addRectangle(0, 0, 100, 50, '#000', 2, 1);
      editor.tool = 'select';
      editor.select(r);
      editor.tool = 'pencil';
      expect(editor.selectedId).toBeNull();
    });
  });

  describe('redimensionar', () => {
    // Retângulo 0,0–100,50 com traço 2: a moldura fica 6 px + 1 (meio traço) para fora,
    // então a alça do canto inferior direito fica em (107, 57) na tela, com zoom 1.
    function selectedRect(): string {
      const r = editor.board.addRectangle(0, 0, 100, 50, '#000', 2, 1);
      editor.tool = 'select';
      editor.select(r);
      return r;
    }

    it('acha as alças só com algo selecionado', () => {
      expect(editor.handleAt(107, 57)).toBeNull();
      selectedRect();
      expect(editor.handleAt(107, 57)).toBe('se');
      expect(editor.handleAt(-7, -7)).toBe('nw');
      expect(editor.handleAt(107, -7)).toBe('ne');
      expect(editor.handleAt(-7, 57)).toBe('sw');
      expect(editor.handleAt(50, 25)).toBeNull();
    });

    it('dedo alcança a alça de mais longe que o mouse', () => {
      selectedRect();
      expect(editor.handleAt(122, 57)).toBeNull();
      expect(editor.handleAt(122, 57, 'touch')).toBe('se');
    });

    it('puxar o canto aumenta, mantendo o canto oposto parado', () => {
      const r = selectedRect();
      editor.pointerDown(mouse(107, 57));
      editor.pointerMove(mouse(157, 107));
      editor.pointerUp(mouse(157, 107));
      expect(rectOf(editor.board, r)).toMatchObject({ x: 0, y: 0, width: 150, height: 100 });
      expect(editor.selectedId).toBe(r);
    });

    it('puxar o canto de cima à esquerda para dentro diminui', () => {
      const r = selectedRect();
      editor.pointerDown(mouse(-7, -7));
      editor.pointerMove(mouse(43, 13));
      editor.pointerUp(mouse(43, 13));
      expect(rectOf(editor.board, r)).toMatchObject({ x: 50, y: 20, width: 50, height: 30 });
    });

    it('com Shift mantém a proporção', () => {
      const r = selectedRect();
      editor.pointerDown(mouse(107, 57));
      editor.pointerMove(mouse(307, 67, { shift: true }));
      editor.pointerUp(mouse(307, 67));
      expect(rectOf(editor.board, r)).toMatchObject({ x: 0, y: 0, width: 300, height: 150 });
    });

    it('respeita o zoom', () => {
      const r = selectedRect();
      editor.camera = { x: 0, y: 0, zoom: 2 };
      // Com zoom 2: canto em (200, 100) na tela, moldura 6 px + 1 unidade (2 px) para fora.
      expect(editor.handleAt(208, 108)).toBe('se');
      editor.pointerDown(mouse(208, 108));
      editor.pointerMove(mouse(308, 108));
      editor.pointerUp(mouse(308, 108));
      expect(rectOf(editor.board, r)).toMatchObject({ width: 150, height: 50 });
    });

    it('texto cresce por igual e a fonte acompanha', () => {
      const id = editor.commitText({ world: { x: 0, y: 0 } }, 'oi', { width: 40, height: 30 }) ?? '';
      editor.tool = 'select';
      editor.select(id);
      // Texto não tem traço: alça a 6 px do canto (40, 30).
      editor.pointerDown(mouse(46, 36));
      editor.pointerMove(mouse(86, 36));
      editor.pointerUp(mouse(86, 36));
      expect(Array.from(editor.board.bounds(id) ?? [])).toEqual([0, 0, 80, 60]);
      expect(editor.board.fontSize(id)).toBe(48);
    });

    it('traço livre estica junto', () => {
      editor.pointerDown(mouse(0, 0));
      editor.pointerMove(mouse(100, 50));
      editor.pointerUp(mouse(100, 50));
      const [id] = editor.board.visibleIds();
      editor.tool = 'select';
      editor.select(id ?? null);
      editor.pointerDown(mouse(107, 57));
      editor.pointerMove(mouse(207, 107));
      editor.pointerUp(mouse(207, 107));
      expect(Array.from(editor.board.bounds(id ?? '') ?? [])).toEqual([0, 0, 200, 100]);
    });
  });

  describe('imagem', () => {
    const image = { fileId: 'f1', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAA', width: 200, height: 100 };

    it('entra centrada no ponto, selecionada e com a ferramenta de seleção', () => {
      const onSelectionChange = vi.fn();
      editor = new Editor(editor.board, { onSelectionChange, onDocumentChange });
      editor.tool = 'pencil';
      const id = editor.insertImage(image, { x: 400, y: 300 }, { width: 800, height: 600 });
      expect(Array.from(editor.board.bounds(id) ?? [])).toEqual([300, 250, 500, 350]);
      expect(editor.tool).toBe('select');
      expect(editor.selectedId).toBe(id);
      expect(onSelectionChange).toHaveBeenCalledWith(id);
      expect(onDocumentChange).toHaveBeenCalled();
    });

    it('redimensiona mantendo a proporção', () => {
      const id = editor.insertImage(image, { x: 100, y: 50 }, { width: 800, height: 600 });
      // Imagem em 0,0–200,100, sem traço: alça a 6 px do canto.
      editor.pointerDown(mouse(206, 106));
      editor.pointerMove(mouse(406, 120));
      editor.pointerUp(mouse(406, 120));
      expect(Array.from(editor.board.bounds(id) ?? [])).toEqual([0, 0, 400, 200]);
    });

    it('borracha apaga imagem', () => {
      editor.insertImage(image, { x: 100, y: 50 }, { width: 800, height: 600 });
      editor.tool = 'eraser';
      editor.pointerDown(mouse(100, 50));
      editor.pointerUp(mouse(100, 50));
      expect(editor.board.visibleIds()).toEqual([]);
    });
  });

  describe('copiar e colar', () => {
    function selectedRect(): string {
      const r = editor.board.addRectangle(0, 0, 100, 50, '#000', 2, 1);
      editor.tool = 'select';
      editor.select(r);
      return r;
    }

    it('sem seleção não copia nada', () => {
      expect(editor.copySelection()).toBeNull();
      expect(editor.cutSelection()).toBeNull();
      expect(editor.duplicateSelection()).toEqual([]);
    });

    it('copiar e colar no ponto centra a cópia ali e seleciona', () => {
      const r = selectedRect();
      const json = editor.copySelection() ?? '';
      editor.camera = { x: 0, y: 0, zoom: 2 };
      const [copy] = editor.paste(json, { x: 400, y: 200 });
      expect(copy).not.toBe(r);
      // Ponto (400, 200) na tela com zoom 2 = (200, 100) no mundo: centro da cópia.
      expect(rectOf(editor.board, copy ?? '')).toMatchObject({ x: 150, y: 75, width: 100, height: 50 });
      expect(editor.selectedId).toBe(copy);
      expect(editor.tool).toBe('select');
    });

    it('colar sem ponto põe ao lado do original', () => {
      selectedRect();
      const [copy] = editor.paste(editor.copySelection() ?? '', null);
      expect(rectOf(editor.board, copy ?? '')).toMatchObject({ x: 16, y: 16 });
    });

    it('recortar copia e tira do quadro', () => {
      selectedRect();
      const json = editor.cutSelection();
      expect(isClipboard(json ?? '')).toBe(true);
      expect(editor.board.visibleIds()).toEqual([]);
      expect(editor.selectedId).toBeNull();
      editor.paste(json ?? '', null);
      expect(editor.board.visibleIds()).toHaveLength(1);
    });

    it('duplicar cria a cópia ao lado e seleciona a cópia', () => {
      const r = selectedRect();
      const [dup] = editor.duplicateSelection();
      expect(editor.board.visibleIds()).toEqual([r, dup]);
      expect(editor.selectedId).toBe(dup);
    });

    it('colar entre desenhos diferentes leva a imagem junto', () => {
      const image = { fileId: 'f1', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAA', width: 20, height: 20 };
      editor.insertImage(image, { x: 10, y: 10 }, { width: 800, height: 600 });
      const json = editor.copySelection() ?? '';
      const other = new Editor(newBoard());
      const [pasted] = other.paste(json, { x: 0, y: 0 });
      expect(other.board.fileDataUrl(other.board.imageFileId(pasted ?? '') ?? '')).toBe(image.dataUrl);
      other.board.free();
    });

    it('conteúdo que não é do draw4fun dá erro', () => {
      expect(() => editor.paste('olá', null)).toThrow(/não é do draw4fun/);
    });

    it('texto comum colado vira elemento de texto no ponto', () => {
      const id = editor.pasteText('lista de compras', { x: 40, y: 60 }, { width: 150, height: 30 });
      expect(editor.board.text(id ?? '')).toBe('lista de compras');
      expect(Array.from(editor.board.bounds(id ?? '') ?? []).slice(0, 2)).toEqual([40, 60]);
      expect(editor.selectedId).toBe(id);
    });
  });

  describe('desfazer e refazer', () => {
    function drawRect(x: number, y: number): string {
      editor.tool = 'rectangle';
      editor.pointerDown(mouse(x, y));
      editor.pointerMove(mouse(x + 20, y + 10));
      editor.pointerMove(mouse(x + 50, y + 30));
      editor.pointerUp(mouse(x + 50, y + 30));
      return editor.board.visibleIds().at(-1) ?? '';
    }

    it('cada gesto é um passo; desfazer e refazer andam por eles', () => {
      expect(editor.canUndo).toBe(false);
      const a = drawRect(0, 0);
      const b = drawRect(100, 0);
      expect(editor.canUndo).toBe(true);
      expect(editor.undo()).toBe(true);
      expect(editor.board.visibleIds()).toEqual([a]);
      expect(editor.canRedo).toBe(true);
      expect(editor.redo()).toBe(true);
      expect(editor.board.visibleIds()).toEqual([a, b]);
      expect(editor.redo()).toBe(false);
    });

    it('desfazer um arrasto volta o elemento para onde estava', () => {
      const r = drawRect(0, 0);
      editor.tool = 'select';
      editor.pointerDown(mouse(0, 15));
      for (let i = 1; i <= 10; i++) editor.pointerMove(mouse(i * 10, 15));
      editor.pointerUp(mouse(100, 15));
      expect(rectOf(editor.board, r)).toMatchObject({ x: 100 });
      editor.undo();
      expect(rectOf(editor.board, r)).toMatchObject({ x: 0, y: 0, width: 50, height: 30 });
    });

    it('desfazer a borracha traz de volta tudo o que ela apagou no gesto', () => {
      const a = drawRect(0, 0);
      const b = drawRect(100, 0);
      editor.tool = 'eraser';
      editor.pointerDown(mouse(25, -10));
      editor.pointerMove(mouse(25, 15));
      editor.pointerMove(mouse(125, 15));
      editor.pointerUp(mouse(125, 15));
      expect(editor.board.visibleIds()).toEqual([]);
      editor.undo();
      expect(editor.board.visibleIds()).toEqual([a, b]);
    });

    it('desfazer edição de texto volta o texto antigo', () => {
      const id = editor.commitText({ world: { x: 0, y: 0 } }, 'antes', { width: 50, height: 30 }) ?? '';
      editor.commitText({ id, world: { x: 0, y: 0 } }, 'depois', { width: 60, height: 30 });
      editor.undo();
      expect(editor.board.text(id)).toBe('antes');
      editor.undo();
      expect(editor.board.visibleIds()).toEqual([]);
    });

    it('desfazer a criação do selecionado desfaz a seleção', () => {
      const r = drawRect(0, 0);
      editor.tool = 'select';
      editor.select(r);
      editor.undo();
      expect(editor.selectedId).toBeNull();
    });

    it('desfazer apagar e duplicar', () => {
      const r = drawRect(0, 0);
      editor.tool = 'select';
      editor.select(r);
      editor.duplicateSelection();
      editor.deleteSelected();
      expect(editor.board.visibleIds()).toEqual([r]);
      editor.undo();
      expect(editor.board.visibleIds()).toHaveLength(2);
      editor.undo();
      expect(editor.board.visibleIds()).toEqual([r]);
    });

    it('clique sem arrastar com o retângulo não cria passo', () => {
      editor.tool = 'rectangle';
      editor.pointerDown(mouse(10, 10));
      editor.pointerUp(mouse(10, 10));
      expect(editor.canUndo).toBe(false);
    });

    it('no meio de um gesto, desfazer não faz nada', () => {
      drawRect(0, 0);
      editor.tool = 'pencil';
      editor.pointerDown(mouse(200, 200));
      editor.pointerMove(mouse(220, 220));
      expect(editor.undo()).toBe(false);
      editor.pointerUp(mouse(220, 220));
      expect(editor.board.visibleIds()).toHaveLength(2);
    });
  });

  describe('mudanças de outro aparelho', () => {
    it('junta o remoto, avisa como mudança remota e desfaz seleção de quem sumiu', () => {
      const onRemoteChange = vi.fn();
      editor = new Editor(editor.board, { onRemoteChange, onDocumentChange });
      const r = editor.board.addRectangle(0, 0, 10, 10, '#000', 2, 1);
      const other = newBoard();
      other.mergeRemote(editor.board.toJson());
      other.remove(r);
      const extra = other.addRectangle(50, 0, 10, 10, '#000', 2, 1);
      editor.tool = 'select';
      editor.select(r);
      editor.mergeRemote(other.toJson());
      expect(editor.board.visibleIds()).toEqual([extra]);
      expect(editor.selectedId).toBeNull();
      expect(onRemoteChange).toHaveBeenCalledTimes(1);
      expect(onDocumentChange).not.toHaveBeenCalled();
      other.free();
    });

    it('JSON ilegível lança erro sem mexer no quadro', () => {
      const r = editor.board.addRectangle(0, 0, 10, 10, '#000', 2, 1);
      expect(() => editor.mergeRemote('{"schemaVersion":99,"elements":[]}')).toThrow();
      expect(editor.board.visibleIds()).toEqual([r]);
    });
  });

  describe('borracha', () => {
    it('passar por cima apaga o que encostar, e só isso', () => {
      const a = editor.board.addRectangle(0, 0, 50, 50, '#000', 2, 1);
      const b = editor.board.addRectangle(200, 0, 50, 50, '#000', 2, 1);
      const c = editor.board.addRectangle(400, 400, 50, 50, '#000', 2, 1);
      editor.tool = 'eraser';
      editor.pointerDown(mouse(25, -20));
      // Gesto rápido de um elemento ao outro: as amostras intermediárias pegam os dois.
      editor.pointerMove(mouse(25, 25));
      editor.pointerMove(mouse(225, 25));
      editor.pointerUp(mouse(225, 25));
      expect(editor.board.visibleIds()).toEqual([c]);
      expect(editor.board.visibleIds()).not.toContain(a);
      expect(editor.board.visibleIds()).not.toContain(b);
    });

    it('borracha apaga traço livre', () => {
      editor.pointerDown(mouse(0, 0));
      editor.pointerMove(mouse(100, 0));
      editor.pointerUp(mouse(100, 0));
      editor.tool = 'eraser';
      editor.pointerDown(mouse(50, 3));
      editor.pointerUp(mouse(50, 3));
      expect(editor.board.visibleIds()).toEqual([]);
    });
  });

  describe('texto', () => {
    const size = { width: 60, height: 30 };

    it('clique com a ferramenta de texto pede a caixa no ponto do mundo', () => {
      const onTextRequest = vi.fn();
      editor = new Editor(editor.board, { onTextRequest });
      editor.tool = 'text';
      editor.camera = { x: 100, y: 0, zoom: 2 };
      editor.pointerDown(mouse(20, 40));
      editor.pointerUp(mouse(20, 40));
      expect(onTextRequest).toHaveBeenCalledWith({ world: { x: 110, y: 20 } });
      expect(editor.board.visibleIds()).toEqual([]);
    });

    it('gravar cria o texto com a cor e o tamanho atuais', () => {
      editor.ink = { ...editor.ink, color: '#15803d' };
      const id = editor.commitText({ world: { x: 5, y: 6 } }, 'Olá\nmundo', size);
      expect(id).not.toBeNull();
      expect(editor.board.text(id ?? '')).toBe('Olá\nmundo');
      expect(editor.board.strokeColor(id ?? '')).toBe('#15803d');
      expect(editor.board.fontSize(id ?? '')).toBe(24);
      expect(Array.from(editor.board.bounds(id ?? '') ?? [])).toEqual([5, 6, 65, 36]);
      expect(onDocumentChange).toHaveBeenCalled();
    });

    it('texto vazio não cria nada', () => {
      expect(editor.commitText({ world: { x: 0, y: 0 } }, '   \n ', size)).toBeNull();
      expect(editor.board.visibleIds()).toEqual([]);
      expect(onDocumentChange).not.toHaveBeenCalled();
    });

    it('editar troca o conteúdo; esvaziar apaga', () => {
      const id = editor.commitText({ world: { x: 0, y: 0 } }, 'a', size) ?? '';
      editor.commitText({ id, world: { x: 0, y: 0 } }, 'b', size);
      expect(editor.board.text(id)).toBe('b');
      expect(editor.board.version(id)).toBe(2);
      editor.commitText({ id, world: { x: 0, y: 0 } }, 'b', size);
      expect(editor.board.version(id)).toBe(2); // sem mudança, sem versão nova
      expect(editor.commitText({ id, world: { x: 0, y: 0 } }, '', size)).toBeNull();
      expect(editor.board.visibleIds()).toEqual([]);
    });

    it('clicar num texto existente com a ferramenta de texto abre para editar', () => {
      const onTextRequest = vi.fn();
      editor = new Editor(editor.board, { onTextRequest });
      const id = editor.commitText({ world: { x: 10, y: 10 } }, 'oi', size) ?? '';
      editor.tool = 'text';
      editor.pointerDown(mouse(30, 20));
      expect(onTextRequest).toHaveBeenCalledWith({ id, world: { x: 10, y: 10 } });
    });

    it('clique duplo na seleção: no texto edita, no vazio começa um novo', () => {
      const onTextRequest = vi.fn();
      editor = new Editor(editor.board, { onTextRequest });
      const id = editor.commitText({ world: { x: 10, y: 10 } }, 'oi', size) ?? '';
      editor.tool = 'select';
      editor.doubleClick(30, 20);
      editor.doubleClick(300, 300);
      expect(onTextRequest.mock.calls).toEqual([[{ id, world: { x: 10, y: 10 } }], [{ world: { x: 300, y: 300 } }]]);
    });

    it('arrastar texto com a seleção move o texto', () => {
      const id = editor.commitText({ world: { x: 10, y: 10 } }, 'oi', size) ?? '';
      editor.tool = 'select';
      editor.pointerDown(mouse(30, 20));
      editor.pointerMove(mouse(40, 30));
      editor.pointerUp(mouse(40, 30));
      expect(Array.from(editor.board.bounds(id) ?? []).slice(0, 2)).toEqual([20, 20]);
    });
  });

  it('zoom pelos botões tem limites', () => {
    for (let i = 0; i < 50; i++) editor.zoomBy(1.2, { x: 0, y: 0 });
    expect(editor.camera.zoom).toBe(10);
    editor.resetZoom({ x: 0, y: 0 });
    expect(editor.camera.zoom).toBe(1);
  });
});
