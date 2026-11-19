// Contas da exportação como imagem (PNG): que pedaço do mundo entra e em que escala.
// O desenho em si fica no Renderer (`renderToCanvas`), que conhece o canvas.

export interface ExportOptions {
  /** Pixels de imagem por unidade do mundo. 2 deixa nítido em telas de alta densidade. */
  scale: number;
  /** Margem em volta dos elementos, em unidades do mundo. */
  padding: number;
  /** Cor do fundo; `null` deixa transparente. */
  background: string | null;
}

export const DEFAULT_EXPORT: ExportOptions = { scale: 2, padding: 16, background: '#ffffff' };

/**
 * Maior lado permitido da imagem, em pixels. Navegadores recusam canvas muito grandes
 * (o limite varia; o Safari é o mais apertado).
 */
export const MAX_EXPORT_SIDE = 8192;

export interface ExportFrame {
  /** Canto superior esquerdo, no mundo. */
  x: number;
  y: number;
  /** Tamanho, no mundo. */
  width: number;
  height: number;
  /** Escala final (pode ser menor que a pedida, para caber em `MAX_EXPORT_SIDE`). */
  scale: number;
  /** Tamanho da imagem, em pixels. */
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * Recorte que cobre todos os limites dados (`[minX, minY, maxX, maxY]`, com a espessura
 * do traço já somada) mais a margem. `null` se não há nada para exportar.
 */
export function exportFrame(bounds: readonly (readonly number[])[], options: ExportOptions = DEFAULT_EXPORT): ExportFrame | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [a = NaN, b = NaN, c = NaN, d = NaN] of bounds) {
    if (![a, b, c, d].every(Number.isFinite)) continue;
    minX = Math.min(minX, a);
    minY = Math.min(minY, b);
    maxX = Math.max(maxX, c);
    maxY = Math.max(maxY, d);
  }
  if (!Number.isFinite(minX)) return null;
  const x = minX - options.padding;
  const y = minY - options.padding;
  const width = Math.max(1, maxX - minX + 2 * options.padding);
  const height = Math.max(1, maxY - minY + 2 * options.padding);
  const scale = Math.min(options.scale, MAX_EXPORT_SIDE / width, MAX_EXPORT_SIDE / height);
  return {
    x,
    y,
    width,
    height,
    scale,
    pixelWidth: Math.max(1, Math.round(width * scale)),
    pixelHeight: Math.max(1, Math.round(height * scale)),
  };
}
