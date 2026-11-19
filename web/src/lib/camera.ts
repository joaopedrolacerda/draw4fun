// Câmera do canvas infinito. `x` e `y` são a coordenada do mundo que aparece no canto
// superior esquerdo da tela; `zoom` é quantos pixels de tela vale uma unidade do mundo.

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Vec {
  x: number;
  y: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 10;

export const initialCamera = (): Camera => ({ x: 0, y: 0, zoom: 1 });

export const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

export function screenToWorld(c: Camera, sx: number, sy: number): Vec {
  return { x: sx / c.zoom + c.x, y: sy / c.zoom + c.y };
}

export function worldToScreen(c: Camera, wx: number, wy: number): Vec {
  return { x: (wx - c.x) * c.zoom, y: (wy - c.y) * c.zoom };
}

/** Arrasta a vista: `dx`, `dy` em pixels de tela, no sentido do movimento da mão. */
export function panBy(c: Camera, dx: number, dy: number): Camera {
  return { ...c, x: c.x - dx / c.zoom, y: c.y - dy / c.zoom };
}

/** Muda o zoom mantendo parado o ponto do mundo que está sob `(sx, sy)` na tela. */
export function zoomAt(c: Camera, sx: number, sy: number, zoom: number): Camera {
  const z = clampZoom(zoom);
  const anchor = screenToWorld(c, sx, sy);
  return { x: anchor.x - sx / z, y: anchor.y - sy / z, zoom: z };
}
