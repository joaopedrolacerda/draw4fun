// Testa a ponte de verdade: estas chamadas atravessam para o Rust compilado em WASM.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Board, boardFromJson, newBoard, randomSeed, schemaVersion } from '.';

const fixture = readFileSync(new URL('../../../../fixtures/sample-board.json', import.meta.url), 'utf8');

describe('ponte WASM', () => {
  it('informa a versão do formato', () => {
    expect(schemaVersion()).toBe(1);
  });

  it('cria retângulo e traço livre e devolve na ordem de desenho', () => {
    const b = newBoard();
    const r = b.addRectangle(0, 0, 100, 50, '#000', 2, 1);
    const f = b.addFreehand(10, 10, 0.5, '#f00', 3);
    expect(b.pushPoint(f, 30, 30, 0.7)).toBe(true);
    expect(b.visibleIds()).toEqual([r, f]);
    expect(b.strokeColor(f)).toBe('#f00');
    expect(b.strokeWidth(r)).toBe(2);
    b.free();
  });

  it('lê o fixture compartilhado com os testes do Rust', () => {
    const b = boardFromJson(fixture);
    expect(b.visibleIds()).toEqual(['a1b2c3d4e5f60001', 'a1b2c3d4e5f60002', 'a1b2c3d4e5f60004', 'a1b2c3d4e5f60005']);
    expect(b.kind('a1b2c3d4e5f60005')).toBe('image');
    expect(b.imageFileId('a1b2c3d4e5f60005')).toBe('9f86d081884c7d65');
    expect(b.fileDataUrl('9f86d081884c7d65')).toMatch(/^data:image\/png;base64,/);
    expect(b.kind('a1b2c3d4e5f60004')).toBe('text');
    expect(b.text('a1b2c3d4e5f60004')).toBe('Ideia boa\nrevisar amanhã');
    expect(b.fontSize('a1b2c3d4e5f60004')).toBe(24);
    expect(b.fontSize('a1b2c3d4e5f60001')).toBeUndefined();
    expect(b.version('a1b2c3d4e5f60002')).toBe(5);
    // O núcleo escreve os campos opcionais (pressão, apagado) com o valor padrão; fora isso, nada muda.
    const written = JSON.parse(b.toJson()) as { elements: { points?: { pressure: number }[]; deleted: boolean }[] };
    expect(written.elements[1]?.points?.[2]?.pressure).toBe(0.5);
    expect(written.elements[0]?.deleted).toBe(false);
    const again = boardFromJson(b.toJson());
    expect(again.toJson()).toBe(b.toJson());
    again.free();
    b.free();
  });

  it('caminho do retângulo vem achatado, em modo contorno', () => {
    const b = boardFromJson(fixture);
    const path = b.path('a1b2c3d4e5f60001');
    expect(path).toBeInstanceOf(Float64Array);
    expect(path?.[0]).toBe(0);
    expect(path?.[1]).toBe(0); // primeiro comando: moveTo
    expect(b.path('nao-existe')).toBeUndefined();
    b.free();
  });

  it('mesma semente desenha igual nos dois lados da ponte', () => {
    const a = boardFromJson(fixture);
    const c = boardFromJson(fixture);
    expect(a.path('a1b2c3d4e5f60001')).toEqual(c.path('a1b2c3d4e5f60001'));
    a.free();
    c.free();
  });

  it('erros do Rust chegam como exceções com mensagem em português', () => {
    expect(() => boardFromJson('{')).toThrow(/JSON inválido/);
    const b = newBoard();
    expect(() => b.setRectangle('nada', 0, 0, 1, 1)).toThrow(/não encontrado/);
    b.free();
  });

  it('clique acerta a borda do retângulo', () => {
    const b = newBoard();
    const r = b.addRectangle(0, 0, 100, 50, '#000', 2, 1);
    expect(b.hitTest(50, 0, 4)).toBe(r);
    expect(b.hitTest(50, 25, 4)).toBeUndefined();
    b.free();
  });

  it('texto, mover e limites atravessam a ponte', () => {
    const b = newBoard();
    const t = b.addText(10, 20, 'oi', 24, 30, 30, '#c2410c');
    expect(b.kind(t)).toBe('text');
    expect(Array.from(b.bounds(t) ?? [])).toEqual([10, 20, 40, 50]);
    b.translate(t, 5, 5);
    b.setText(t, 'olá', 45, 30);
    expect(b.text(t)).toBe('olá');
    expect(Array.from(b.bounds(t) ?? [])).toEqual([15, 25, 60, 55]);
    expect(b.path(t)?.[0]).toBe(2);
    b.resize(t, 0, 0, 90, 60);
    expect(b.fontSize(t)).toBe(48);
    expect(Array.from(b.bounds(t) ?? [])).toEqual([0, 0, 90, 60]);
    expect(b.bounds('nada')).toBeUndefined();
    b.free();
  });

  it('imagem atravessa a ponte e o arquivo vai junto no JSON', () => {
    const b = newBoard();
    const i = b.addImage(0, 0, 40, 20, 'abc', 'image/png', 'data:image/png;base64,AAA');
    b.addImage(50, 0, 40, 20, 'abc', 'image/png', 'data:image/png;base64,AAA');
    expect(b.path(i)?.[0]).toBe(3);
    const doc = JSON.parse(b.toJson()) as { files: Record<string, { dataUrl: string }> };
    expect(Object.keys(doc.files)).toEqual(['abc']);
    expect(b.imageFileId(i)).toBe('abc');
    expect(b.fileDataUrl('nada')).toBeUndefined();
    b.free();
  });

  it('histórico atravessa a ponte', () => {
    const b = newBoard();
    expect(b.canUndo()).toBe(false);
    const r = b.addRectangle(0, 0, 10, 10, '#000', 2, 1);
    expect(b.endStep()).toBe(true);
    expect(b.undo()).toBe(true);
    expect(b.visibleIds()).toEqual([]);
    expect(b.canRedo()).toBe(true);
    expect(b.redo()).toBe(true);
    expect(b.visibleIds()).toEqual([r]);
    b.free();
  });

  it('merge traz o que foi feito em outro aparelho', () => {
    const phone = new Board(...randomSeed());
    const laptop = new Board(...randomSeed());
    const a = phone.addRectangle(0, 0, 10, 10, '#000', 2, 1);
    const c = laptop.addRectangle(20, 20, 10, 10, '#000', 2, 1);
    phone.mergeRemote(laptop.toJson());
    expect(phone.visibleIds()).toEqual([a, c]);
    phone.free();
    laptop.free();
  });
});
