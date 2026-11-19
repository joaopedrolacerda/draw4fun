// Moldura de seleção e alças de redimensionar. Usado pelo editor (clique nas alças)
// e pelo renderer (desenho), para os dois concordarem sobre onde as alças ficam.

import type { Board } from './core';
import type { Vec } from './camera';

export type Handle = 'nw' | 'ne' | 'sw' | 'se';
export const HANDLES: readonly Handle[] = ['nw', 'ne', 'sw', 'se'];

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Folga entre o elemento e a moldura, em pixels de tela. */
export const FRAME_PADDING = 6;
/** Lado do quadradinho da alça, em pixels de tela. */
export const HANDLE_SIZE = 9;

export function elementRect(board: Board, id: string): Rect | null {
  const b = board.bounds(id);
  if (!b) return null;
  const [minX = 0, minY = 0, maxX = 0, maxY = 0] = b;
  return { minX, minY, maxX, maxY };
}

/** Moldura em coordenadas do mundo: o elemento mais a folga e metade da espessura do traço. */
export function selectionFrame(board: Board, id: string, zoom: number): Rect | null {
  const r = elementRect(board, id);
  if (!r) return null;
  const pad = FRAME_PADDING / zoom + (board.strokeWidth(id) ?? 0) / 2;
  return { minX: r.minX - pad, minY: r.minY - pad, maxX: r.maxX + pad, maxY: r.maxY + pad };
}

/** União de retângulos (`null` se a lista está vazia). */
export function unionRect(rects: readonly (Rect | null)[]): Rect | null {
  let out: Rect | null = null;
  for (const r of rects) {
    if (!r) continue;
    out = out
      ? { minX: Math.min(out.minX, r.minX), minY: Math.min(out.minY, r.minY), maxX: Math.max(out.maxX, r.maxX), maxY: Math.max(out.maxY, r.maxY) }
      : { ...r };
  }
  return out;
}

/** Limites de vários elementos juntos, sem folga. */
export function groupRect(board: Board, ids: readonly string[]): Rect | null {
  return unionRect(ids.map((id) => elementRect(board, id)));
}

/** Moldura de vários elementos juntos: a união das molduras de cada um. */
export function groupFrame(board: Board, ids: readonly string[], zoom: number): Rect | null {
  return unionRect(ids.map((id) => selectionFrame(board, id, zoom)));
}

/** Retângulo a partir de dois cantos quaisquer. */
export function rectFrom(a: Vec, b: Vec): Rect {
  return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
}

/** `inner` está inteiro dentro de `outer`. */
export function containsRect(outer: Rect, inner: Rect): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

export function corner(r: Rect, h: Handle): Vec {
  return {
    x: h === 'nw' || h === 'sw' ? r.minX : r.maxX,
    y: h === 'nw' || h === 'ne' ? r.minY : r.maxY,
  };
}

export function opposite(h: Handle): Handle {
  return ({ nw: 'se', se: 'nw', ne: 'sw', sw: 'ne' } as const)[h];
}

export function cursorFor(h: Handle): string {
  return h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize';
}
