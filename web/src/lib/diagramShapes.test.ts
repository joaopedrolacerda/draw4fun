import { describe, expect, it } from 'vitest';
import { type DiagramShape, type Pt, dedupe, layerOrder, shapesBounds, simplify, splitJumps, transformShape } from './diagramShapes';

const line = (points: Pt[], head = false): DiagramShape => ({ kind: 'line', points, head });

describe('simplify', () => {
  it('tira pontos no meio de uma reta e mantém as dobras', () => {
    const pts: Pt[] = [[0, 0], [5, 0.1], [10, 0], [10, 5], [10, 10]];
    expect(simplify(pts, 0.5)).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it('linha de dois pontos fica como está', () => {
    expect(simplify([[0, 0], [3, 4]], 1)).toEqual([[0, 0], [3, 4]]);
  });
});

describe('splitJumps', () => {
  it('corta um caminho em pedaços onde ele pula', () => {
    const pts: Pt[] = [[0, 0], [2, 0], [4, 0], [50, 50], [52, 50]];
    expect(splitJumps(pts, 5)).toEqual([
      [[0, 0], [2, 0], [4, 0]],
      [[50, 50], [52, 50]],
    ]);
  });

  it('pedaço de um ponto só some', () => {
    expect(splitJumps([[0, 0], [100, 0], [102, 0]], 5)).toEqual([[[100, 0], [102, 0]]]);
  });
});

describe('dedupe', () => {
  it('pedaço sobreposto a uma linha mais longa some', () => {
    const long = line([[8, 372], [157, 372]]);
    const piece = line([[11, 373], [150, 372]]);
    expect(dedupe([piece, long])).toEqual([long]);
  });

  it('contorno igual à borda de um retângulo some', () => {
    const rect: DiagramShape = { kind: 'rect', x: 0, y: 0, width: 100, height: 50 };
    const outline = line([[0, 0], [100, 0], [100, 50], [0, 50], [0, 0]]);
    expect(dedupe([rect, outline])).toEqual([rect]);
  });

  it('linha que sai do contorno fica', () => {
    const a = line([[0, 0], [100, 0]]);
    const b = line([[0, 0], [100, 0], [100, 40]]);
    expect(dedupe([a, b])).toEqual([b]);
  });

  it('seta nunca some, mesmo em cima de outra linha', () => {
    const a = line([[0, 0], [100, 0]]);
    const arrow = line([[0, 0], [100, 0]], true);
    expect(dedupe([a, arrow])).toHaveLength(2);
  });

  it('texto repetido no mesmo lugar some; em outro lugar fica', () => {
    const t = (cx: number): DiagramShape => ({ kind: 'text', text: 'API', cx, cy: 10, fontSize: 16 });
    expect(dedupe([t(10), t(11), t(200)])).toEqual([t(10), t(200)]);
  });
});

describe('posição no quadro', () => {
  const shapes: DiagramShape[] = [
    { kind: 'text', text: 'oi', cx: 50, cy: 120, fontSize: 10 },
    line([[0, 0], [100, 100]], true),
    { kind: 'rect', x: 10, y: 10, width: 20, height: 20 },
  ];
  const size = (t: { text: string; fontSize: number }) => ({ width: t.text.length * t.fontSize, height: t.fontSize });

  it('limites incluem o texto pelo tamanho medido', () => {
    expect(shapesBounds(shapes, size)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 125 });
    expect(shapesBounds([], size)).toBeNull();
  });

  it('transforma escala e desloca cada tipo de forma', () => {
    expect(transformShape(shapes[2]!, [10, 10], 2, [100, 200])).toEqual({ kind: 'rect', x: 100, y: 200, width: 40, height: 40 });
    expect(transformShape(shapes[1]!, [0, 0], 0.5, [1, 1])).toEqual(line([[1, 1], [51, 51]], true));
    expect(transformShape(shapes[0]!, [0, 0], 2, [0, 0])).toEqual({ kind: 'text', text: 'oi', cx: 100, cy: 240, fontSize: 20 });
  });

  it('caixas atrás, linhas no meio, texto por cima', () => {
    expect(layerOrder(shapes).map((s) => s.kind)).toEqual(['rect', 'line', 'text']);
  });
});
