import { describe, expect, it } from 'vitest';
import { decodePath, type PathSink } from './path';

function recorder(): PathSink & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    moveTo: (x, y) => calls.push(`M ${x} ${y}`),
    lineTo: (x, y) => calls.push(`L ${x} ${y}`),
    bezierCurveTo: (a, b, c, d, e, f) => calls.push(`C ${a} ${b} ${c} ${d} ${e} ${f}`),
    closePath: () => calls.push('Z'),
  };
}

describe('decodePath', () => {
  it('decodifica todos os comandos e o modo', () => {
    const sink = recorder();
    const mode = decodePath([1, 0, 1, 2, 1, 3, 4, 2, 1, 2, 3, 4, 5, 6, 3], sink);
    expect(mode).toBe('fill');
    expect(sink.calls).toEqual(['M 1 2', 'L 3 4', 'C 1 2 3 4 5 6', 'Z']);
  });

  it('modo 0 é contorno e 2 é texto', () => {
    expect(decodePath([0], recorder())).toBe('stroke');
    expect(decodePath([2], recorder())).toBe('text');
    expect(decodePath([3], recorder())).toBe('image');
  });

  it('recusa caminho truncado ou com comando desconhecido', () => {
    expect(() => decodePath([0, 0, 1], recorder())).toThrow(/truncado/);
    expect(() => decodePath([0, 9], recorder())).toThrow(/desconhecido/);
  });
});
