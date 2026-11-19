import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, initialCamera, panBy, screenToWorld, worldToScreen, zoomAt } from './camera';

describe('câmera', () => {
  it('tela e mundo são inversos', () => {
    const c = { x: 30, y: -10, zoom: 2.5 };
    const w = screenToWorld(c, 120, 80);
    const s = worldToScreen(c, w.x, w.y);
    expect(s.x).toBeCloseTo(120);
    expect(s.y).toBeCloseTo(80);
  });

  it('arrastar para a direita mostra o que estava à esquerda', () => {
    const c = panBy({ x: 0, y: 0, zoom: 2 }, 100, 0);
    expect(c.x).toBe(-50);
  });

  it('zoom mantém parado o ponto sob o cursor', () => {
    const c = { x: 10, y: 20, zoom: 1 };
    const before = screenToWorld(c, 300, 200);
    const z = zoomAt(c, 300, 200, 3);
    const after = screenToWorld(z, 300, 200);
    expect(z.zoom).toBe(3);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('zoom tem limites', () => {
    expect(zoomAt(initialCamera(), 0, 0, 1000).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(initialCamera(), 0, 0, 0.0001).zoom).toBe(MIN_ZOOM);
  });
});
