// Desenha o quadro num CanvasRenderingContext2D. Cada elemento vira um Path2D, guardado
// em cache pela versão: só o que mudou volta a passar pelo núcleo.

import type { Board } from './core';
import type { Camera } from './camera';
import { decodePath, type PaintMode } from './path';
import { HANDLES, HANDLE_SIZE, corner, selectionFrame } from './selection';
import { LINE_HEIGHT, fontString, lines } from './text';

interface Cached {
  version: number;
  path: Path2D;
  mode: PaintMode;
  color: string;
  width: number;
  /** Só para texto: conteúdo, tamanho da fonte e canto superior esquerdo. */
  text?: { lines: string[]; fontSize: number; x: number; y: number };
  /** Só para imagem: chave do arquivo e limites. */
  image?: { fileId: string; x: number; y: number; width: number; height: number };
}

export interface DrawOptions {
  selectedId?: string | null;
  /** Elemento que não deve aparecer (o texto sendo editado na caixa de texto). */
  hiddenId?: string | null;
}

const GRID_STEP = 24;

export class Renderer {
  private cache = new Map<string, Cached>();
  /** Imagens decodificadas, pela chave do arquivo. */
  private images = new Map<string, HTMLImageElement>();

  /** `onImageReady` é chamado quando uma imagem termina de carregar: hora de redesenhar. */
  constructor(private onImageReady: () => void = () => {}) {}

  draw(
    ctx: CanvasRenderingContext2D,
    board: Board,
    camera: Camera,
    width: number,
    height: number,
    dpr: number,
    options: DrawOptions = {},
  ): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawDots(ctx, camera, width, height);

    ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, -camera.x * camera.zoom * dpr, -camera.y * camera.zoom * dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const seen = new Set<string>();
    for (const id of board.visibleIds()) {
      seen.add(id);
      const item = this.lookup(board, id);
      if (!item || id === options.hiddenId) continue;
      if (item.image) {
        this.drawImage(ctx, board, item.image, camera.zoom);
      } else if (item.text) {
        const t = item.text;
        const lh = t.fontSize * LINE_HEIGHT;
        ctx.font = fontString(t.fontSize);
        ctx.textBaseline = 'middle';
        ctx.fillStyle = item.color;
        // Centro de cada linha, como na caixa de texto: assim o texto não pula ao gravar.
        t.lines.forEach((line, i) => ctx.fillText(line, t.x, t.y + i * lh + lh / 2));
      } else if (item.mode === 'fill') {
        ctx.fillStyle = item.color;
        ctx.fill(item.path);
      } else {
        ctx.strokeStyle = item.color;
        ctx.lineWidth = item.width;
        ctx.stroke(item.path);
      }
    }
    for (const id of this.cache.keys()) if (!seen.has(id)) this.cache.delete(id);

    if (options.selectedId && options.selectedId !== options.hiddenId) {
      drawSelection(ctx, board, options.selectedId, camera.zoom);
    }
  }

  private drawImage(ctx: CanvasRenderingContext2D, board: Board, img: NonNullable<Cached['image']>, zoom: number): void {
    let el = this.images.get(img.fileId);
    if (!el) {
      const url = board.fileDataUrl(img.fileId);
      if (url) {
        el = new Image();
        el.onload = () => this.onImageReady();
        el.src = url;
        this.images.set(img.fileId, el);
      }
    }
    if (el?.complete && el.naturalWidth > 0) {
      ctx.drawImage(el, img.x, img.y, img.width, img.height);
      return;
    }
    // Ainda carregando (ou arquivo faltando): um retângulo claro no lugar.
    ctx.save();
    ctx.fillStyle = '#eceae4';
    ctx.fillRect(img.x, img.y, img.width, img.height);
    ctx.strokeStyle = '#cfcac0';
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(img.x, img.y, img.width, img.height);
    ctx.restore();
  }

  private lookup(board: Board, id: string): Cached | undefined {
    const version = board.version(id);
    if (version === undefined) return undefined;
    const hit = this.cache.get(id);
    if (hit && hit.version === version) return hit;
    const data = board.path(id);
    if (!data) return undefined;
    const path = new Path2D();
    const mode = decodePath(data, path);
    const item: Cached = {
      version,
      path,
      mode,
      color: board.strokeColor(id) ?? '#000',
      width: board.strokeWidth(id) ?? 1,
    };
    if (mode === 'image') {
      const b = board.bounds(id);
      const [x = 0, y = 0, maxX = 0, maxY = 0] = b ?? [];
      item.image = { fileId: board.imageFileId(id) ?? '', x, y, width: maxX - x, height: maxY - y };
    }
    if (mode === 'text') {
      const b = board.bounds(id);
      item.text = {
        lines: lines(board.text(id) ?? ''),
        fontSize: board.fontSize(id) ?? 24,
        x: b?.[0] ?? 0,
        y: b?.[1] ?? 0,
      };
    }
    this.cache.set(id, item);
    return item;
  }
}

/** Grade de pontinhos que acompanha o zoom; some quando fica densa demais. */
function drawDots(ctx: CanvasRenderingContext2D, c: Camera, width: number, height: number): void {
  let step = GRID_STEP * c.zoom;
  while (step < 12) step *= 2;
  const offsetX = -((c.x * c.zoom) % step);
  const offsetY = -((c.y * c.zoom) % step);
  ctx.fillStyle = getComputedStyle(ctx.canvas).getPropertyValue('--grid-dot').trim() || '#d9d6cf';
  for (let x = offsetX; x < width; x += step) {
    for (let y = offsetY; y < height; y += step) {
      ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
  }
}

/** Moldura tracejada em volta do selecionado e as alças de redimensionar nos cantos. */
function drawSelection(ctx: CanvasRenderingContext2D, board: Board, id: string, zoom: number): void {
  const frame = selectionFrame(board, id, zoom);
  if (!frame) return;
  const accent = getComputedStyle(ctx.canvas).getPropertyValue('--accent').trim() || '#e8590c';
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([6 / zoom, 4 / zoom]);
  ctx.strokeRect(frame.minX, frame.minY, frame.maxX - frame.minX, frame.maxY - frame.minY);
  ctx.setLineDash([]);
  const size = HANDLE_SIZE / zoom;
  ctx.fillStyle = '#ffffff';
  for (const h of HANDLES) {
    const c = corner(frame, h);
    ctx.fillRect(c.x - size / 2, c.y - size / 2, size, size);
    ctx.strokeRect(c.x - size / 2, c.y - size / 2, size, size);
  }
  ctx.restore();
}
