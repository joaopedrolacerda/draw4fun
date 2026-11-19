import { describe, expect, it } from 'vitest';
import { LINE_HEIGHT, fontString, measureText } from './text';

// Medida falsa: cada caractere vale meia letra do tamanho da fonte.
const fake = (size: number) => (line: string) => line.length * size * 0.5;

describe('measureText', () => {
  it('largura é a da linha mais comprida; altura soma as linhas', () => {
    expect(measureText('oi\nmundo', 20, fake(20))).toEqual({ width: 50, height: 2 * 20 * LINE_HEIGHT });
  });

  it('linha vazia conta na altura e não na largura', () => {
    expect(measureText('', 10, fake(10))).toEqual({ width: 0, height: 10 * LINE_HEIGHT });
    expect(measureText('a\n\n', 10, fake(10)).height).toBe(3 * 10 * LINE_HEIGHT);
  });

  it('fonte inclui o tamanho e a família manuscrita', () => {
    expect(fontString(24)).toMatch(/^24px Kalam/);
  });
});
