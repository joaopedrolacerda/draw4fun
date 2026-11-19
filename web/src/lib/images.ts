// Imagens: leitura do arquivo (upload, colar, arrastar), redução das muito grandes,
// chave pelo conteúdo e posição inicial no quadro.

import { type Camera, type Vec, screenToWorld } from './camera';
import type { Rect } from './selection';

export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** Lado máximo guardado. Fotos de celular passam fácil de 4000 px e pesariam vários MB no arquivo. */
export const MAX_SIDE = 2048;
/** Acima disso a imagem é recomprimida mesmo que caiba no tamanho. */
export const MAX_BYTES = 1_500_000;

export interface LoadedImage {
  fileId: string;
  mimeType: string;
  dataUrl: string;
  width: number;
  height: number;
}

export const isAcceptedImage = (type: string): boolean => (ACCEPTED_TYPES as readonly string[]).includes(type);

/** Só os arquivos de imagem aceitos de uma lista (upload, área de transferência, arrastar). */
export function pickImageFiles(files: Iterable<File> | ArrayLike<File> | null | undefined): File[] {
  if (!files) return [];
  return Array.from(files).filter((f) => isAcceptedImage(f.type));
}

/** Tipo de um data URL (`data:image/png;base64,...` -> `image/png`). */
export function mimeOf(dataUrl: string): string {
  const match = /^data:([^;,]+)/.exec(dataUrl);
  return match?.[1] ?? 'application/octet-stream';
}

/** Reduz para caber em `max` x `max`, mantendo a proporção. Nunca aumenta. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Onde a imagem entra no quadro: centrada em `centerScreen`, no tamanho natural, mas sem
 * ocupar mais que `fraction` da tela em nenhuma direção.
 */
export function placeImage(
  natural: { width: number; height: number },
  centerScreen: Vec,
  camera: Camera,
  viewport: { width: number; height: number },
  fraction = 0.5,
): Rect {
  const maxW = (viewport.width * fraction) / camera.zoom;
  const maxH = (viewport.height * fraction) / camera.zoom;
  const scale = Math.min(1, maxW / natural.width, maxH / natural.height);
  const w = natural.width * scale;
  const h = natural.height * scale;
  const c = screenToWorld(camera, centerScreen.x, centerScreen.y);
  return { minX: c.x - w / 2, minY: c.y - h / 2, maxX: c.x + w / 2, maxY: c.y + h / 2 };
}

/** Chave do arquivo: os primeiros 128 bits do SHA-256 do conteúdo, em hexadecimal. */
export async function fileIdFor(dataUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dataUrl));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('leitura vazia')));
    reader.onerror = () => reject(reader.error ?? new Error('não leu o arquivo'));
    reader.readAsDataURL(file);
  });
}

function decode(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('A imagem não pôde ser aberta.'));
    img.src = dataUrl;
  });
}

/** Lê um arquivo de imagem do navegador, reduzindo se for grande demais. */
export async function loadImageFile(file: Blob): Promise<LoadedImage> {
  if (!isAcceptedImage(file.type)) throw new Error('Formato de imagem não suportado. Use PNG, JPEG, GIF ou WebP.');
  let dataUrl = await readAsDataUrl(file);
  const img = await decode(dataUrl);
  let { naturalWidth: width, naturalHeight: height } = img;

  if (Math.max(width, height) > MAX_SIDE || file.size > MAX_BYTES) {
    const size = fitWithin(width, height, MAX_SIDE);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(img, 0, 0, size.width, size.height);
      // WebP mantém a transparência; navegador sem WebP devolve PNG sozinho.
      const reduced = canvas.toDataURL('image/webp', 0.9);
      if (reduced.length < dataUrl.length) {
        dataUrl = reduced;
        ({ width, height } = size);
      }
    }
  }

  return { fileId: await fileIdFor(dataUrl), mimeType: mimeOf(dataUrl), dataUrl, width, height };
}
