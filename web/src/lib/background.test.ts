import { describe, expect, it } from 'vitest';
import { BACKGROUNDS, DEFAULT_BACKGROUND, displayInk, gridDotColor, isDark, luminance, resolveBackground } from './background';
import { INK_COLORS } from './editor';

const PRETO = BACKGROUNDS.find((b) => b.label === 'Preto')!.color;
const AMARELO = BACKGROUNDS.find((b) => b.label === 'Amarelo')!.color;

describe('fundo do quadro', () => {
  it('oferece branco, preto e amarelo, com o branco como padrão', () => {
    expect(BACKGROUNDS.map((b) => b.label)).toEqual(['Branco', 'Preto', 'Amarelo']);
    expect(DEFAULT_BACKGROUND).toBe(BACKGROUNDS[0]!.color);
  });

  it('só o preto conta como fundo escuro', () => {
    expect(BACKGROUNDS.filter((b) => isDark(b.color)).map((b) => b.label)).toEqual(['Preto']);
  });

  it('luminância entende #rgb e #rrggbb e recusa o resto', () => {
    expect(luminance('#fff')).toBeCloseTo(1);
    expect(luminance('#000000')).toBe(0);
    expect(luminance('red')).toBeNull();
  });

  it('tinta escura vira clara no fundo preto e volta no claro', () => {
    const ink = INK_COLORS[0];
    expect(displayInk(ink, PRETO)).not.toBe(ink);
    expect(isDark(displayInk(ink, PRETO))).toBe(false);
    expect(displayInk(ink, DEFAULT_BACKGROUND)).toBe(ink);
    expect(displayInk(ink, AMARELO)).toBe(ink);
  });

  it('as cores do lápis continuam como estão em qualquer fundo', () => {
    for (const ink of INK_COLORS.slice(1)) {
      for (const b of BACKGROUNDS) expect(displayInk(ink, b.color)).toBe(ink);
    }
  });

  it('tinta branca colada fica escura em fundo claro', () => {
    expect(isDark(displayInk('#ffffff', AMARELO))).toBe(true);
    expect(displayInk('#ffffff', PRETO)).toBe('#ffffff');
  });

  it('cor desconhecida passa direto', () => {
    expect(displayInk('rebeccapurple', PRETO)).toBe('rebeccapurple');
  });

  it('pontinhos da grade claros no preto e escuros no resto', () => {
    expect(gridDotColor(PRETO)).toContain('255');
    expect(gridDotColor(AMARELO)).not.toContain('255');
  });

  it('amarelo é bem clarinho', () => {
    expect(luminance(AMARELO)!).toBeGreaterThan(0.9);
  });

  it('quadro salvo com o amarelo antigo passa a usar o novo', () => {
    expect(resolveBackground('#fdf0a6')).toBe(AMARELO);
    expect(resolveBackground('#FDF0A6')).toBe(AMARELO);
    expect(resolveBackground(PRETO)).toBe(PRETO);
    expect(resolveBackground(undefined)).toBe(DEFAULT_BACKGROUND);
  });
});
