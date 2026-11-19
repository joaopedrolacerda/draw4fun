// Desenha o quadro num CanvasRenderingContext2D. Cada elemento vira um Path2D, guardado
// em cache pela versão: só o que mudou volta a passar pelo núcleo.

import type { Board } from './core';
import type { Camera } from './camera';
import { decodePath, type PaintMode } from './path';
import { HANDLES, HANDLE_SIZE, type Rect, corner, groupFrame, selectionFrame } from './selection';
import { LINE_HEIGHT, fontString, lines } from './text';
import { DEFAULT_EXPORT, type ExportOptions, exportFrame } from './exportImage';
import { DEFAULT_BACKGROUND, displayInk, gridDotColor } from './background';

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
  selectedIds?: readonly string[];
  /** Seleção por caixa em andamento, no mundo. */
  marquee?: Rect | null;
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
    const background = board.background() ?? DEFAULT_BACKGROUND;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    drawDots(ctx, camera, width, height, gridDotColor(background));

    ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, -camera.x * camera.zoom * dpr, -camera.y * camera.zoom * dpr);
    const all = board.visibleIds();
    this.drawElements(ctx, board, all, camera.zoom, options.hiddenId ?? null, background);
    const seen = new Set(all);
    for (const id of this.cache.keys()) if (!seen.has(id)) this.cache.delete(id);

    const selected = (options.selectedIds ?? []).filter((id) => id !== options.hiddenId);
    if (selected.length > 0) drawSelection(ctx, board, selected, camera.zoom);
    if (options.marquee) drawMarquee(ctx, options.marquee, camera.zoom);
  }

  /**
   * Desenha só os elementos `ids` (na ordem do quadro, o de trás primeiro) num canvas novo,
   * sem grade nem seleção, para exportar como imagem. Espera as imagens carregarem antes.
   * `null` se nenhum deles existe.
   */
  async renderToCanvas(board: Board, ids: readonly string[], options: ExportOptions = DEFAULT_EXPORT): Promise<HTMLCanvasElement | null> {
    const wanted = new Set(ids);
    const ordered = board.visibleIds().filter((id) => wanted.has(id));
    const frame = exportFrame(
      ordered.map((id) => {
        const [minX = NaN, minY = NaN, maxX = NaN, maxY = NaN] = board.bounds(id) ?? [];
        // Metade da espessura do traço fica para fora dos limites do elemento.
        const half = (board.strokeWidth(id) ?? 0) / 2;
        return [minX - half, minY - half, maxX + half, maxY + half];
      }),
      options,
    );
    if (!frame) return null;
    await Promise.all(ordered.map((id) => this.ensureImage(board, id)));

    const canvas = document.createElement('canvas');
    canvas.width = frame.pixelWidth;
    canvas.height = frame.pixelHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (options.background) {
      ctx.fillStyle = options.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const sx = frame.pixelWidth / frame.width;
    const sy = frame.pixelHeight / frame.height;
    ctx.setTransform(sx, 0, 0, sy, -frame.x * sx, -frame.y * sy);
    this.drawElements(ctx, board, ordered, frame.scale, null, options.background ?? DEFAULT_BACKGROUND);
    return canvas;
  }

  /** Como `renderToCanvas`, já em PNG. */
  async renderToPng(board: Board, ids: readonly string[], options: ExportOptions = DEFAULT_EXPORT): Promise<Blob> {
    const canvas = await this.renderToCanvas(board, ids, options);
    if (!canvas) throw new Error('Nada selecionado para copiar.');
    return new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('O navegador não gerou a imagem.'))), 'image/png'),
    );
  }

  private drawElements(
    ctx: CanvasRenderingContext2D,
    board: Board,
    ids: readonly string[],
    zoom: number,
    hiddenId: string | null,
    background: string,
  ): void {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const id of ids) {
      const item = this.lookup(board, id);
      if (!item || id === hiddenId) continue;
      const color = displayInk(item.color, background);
      if (item.image) {
        this.drawImage(ctx, board, item.image, zoom);
      } else if (item.text) {
        const t = item.text;
        const lh = t.fontSize * LINE_HEIGHT;
        ctx.font = fontString(t.fontSize);
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        // Centro de cada linha, como na caixa de texto: assim o texto não pula ao gravar.
        t.lines.forEach((line, i) => ctx.fillText(line, t.x, t.y + i * lh + lh / 2));
      } else if (item.mode === 'fill') {
        ctx.fillStyle = color;
        ctx.fill(item.path);
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = item.width;
        ctx.stroke(item.path);
      }
    }
  }

  /** Garante que a imagem do elemento (se for imagem) já foi decodificada. */
  private ensureImage(board: Board, id: string): Promise<void> {
    const fileId = board.imageFileId(id);
    if (!fileId) return Promise.resolve();
    const el = this.imageElement(board, fileId);
    if (!el || (el.complete && el.naturalWidth > 0)) return Promise.resolve();
    // Arquivo quebrado não trava a exportação: sai o retângulo claro no lugar.
    return el.decode().catch(() => undefined);
  }

  private imageElement(board: Board, fileId: string): HTMLImageElement | undefined {
    let el = this.images.get(fileId);
    if (!el) {
      const url = board.fileDataUrl(fileId);
      if (url) {
        el = new Image();
        el.onload = () => this.onImageReady();
        el.src = url;
        this.images.set(fileId, el);
      }
    }
    return el;
  }

  private drawImage(ctx: CanvasRenderingContext2D, board: Board, img: NonNullable<Cached['image']>, zoom: number): void {
    const el = this.imageElement(board, img.fileId);
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
function drawDots(ctx: CanvasRenderingContext2D, c: Camera, width: number, height: number, color: string): void {
  let step = GRID_STEP * c.zoom;
  while (step < 12) step *= 2;
  const offsetX = -((c.x * c.zoom) % step);
  const offsetY = -((c.y * c.zoom) % step);
  ctx.fillStyle = color;
  for (let x = offsetX; x < width; x += step) {
    for (let y = offsetY; y < height; y += step) {
      ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
  }
}

function accentOf(ctx: CanvasRenderingContext2D): string {
  return getComputedStyle(ctx.canvas).getPropertyValue('--accent').trim() || '#e8590c';
}

/**
 * Moldura tracejada em volta da seleção e as alças de redimensionar nos cantos. Com vários
 * selecionados, cada um ganha um contorno fino e a moldura com alças cobre o conjunto.
 */
function drawSelection(ctx: CanvasRenderingContext2D, board: Board, ids: readonly string[], zoom: number): void {
  const frame = groupFrame(board, ids, zoom);
  if (!frame) return;
  const accent = accentOf(ctx);
  ctx.save();
  ctx.strokeStyle = accent;
  if (ids.length > 1) {
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1 / zoom;
    ctx.setLineDash([3 / zoom, 3 / zoom]);
    for (const id of ids) {
      const r = selectionFrame(board, id, zoom);
      if (r) ctx.strokeRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
    }
    ctx.globalAlpha = 1;
  }
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

/** Caixa da seleção por arrasto: fundo translúcido e borda fina. */
function drawMarquee(ctx: CanvasRenderingContext2D, r: Rect, zoom: number): void {
  const accent = accentOf(ctx);
  ctx.save();
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.08;
  ctx.fillRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1 / zoom;
  ctx.strokeRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
  ctx.restore();
}
