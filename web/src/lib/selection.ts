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
