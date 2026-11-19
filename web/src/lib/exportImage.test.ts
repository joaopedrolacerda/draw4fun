import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT, MAX_EXPORT_SIDE, exportFrame } from './exportImage';

describe('exportFrame', () => {
  it('cobre todos os elementos com a margem, na escala pedida', () => {
    const frame = exportFrame([
      [10, 20, 110, 70],
      [-30, 40, 50, 90],
    ]);
    expect(frame).toEqual({
      x: -46,
      y: 4,
      width: 172,
      height: 102,
      scale: 2,
      pixelWidth: 344,
      pixelHeight: 204,
    });
  });

  it('nada para exportar devolve null', () => {
    expect(exportFrame([])).toBeNull();
    expect(exportFrame([[NaN, 0, 1, 1]])).toBeNull();
  });

  it('elemento sem largura (linha reta) ainda vira imagem', () => {
    const frame = exportFrame([[0, 0, 100, 0]], { ...DEFAULT_EXPORT, padding: 0 });
    expect(frame?.pixelHeight).toBe(2);
  });

  it('reduz a escala para não passar do tamanho máximo de canvas', () => {
    const frame = exportFrame([[0, 0, 20_000, 100]], { ...DEFAULT_EXPORT, padding: 0 });
    expect(frame?.pixelWidth).toBe(MAX_EXPORT_SIDE);
    expect(frame?.scale).toBeCloseTo(MAX_EXPORT_SIDE / 20_000);
    expect(frame?.pixelHeight).toBe(Math.round(100 * (MAX_EXPORT_SIDE / 20_000)));
  });
});
