// Medida e fonte dos textos. A medida é feita aqui (a plataforma conhece a fonte)
// e guardada no elemento, para o núcleo poder fazer clique, seleção e limites.

/** Fonte manuscrita (Kalam, licença OFL), empacotada com o site para funcionar sem internet. */
export const FONT_FAMILY = 'Kalam, "Segoe Print", "Bradley Hand", cursive';
export const LINE_HEIGHT = 1.25;
export const DEFAULT_FONT_SIZE = 24;

export const fontString = (size: number): string => `${size}px ${FONT_FAMILY}`;

export const lines = (text: string): string[] => text.split('\n');

export interface TextSize {
  width: number;
  height: number;
}

/**
 * Mede um texto de várias linhas. `measureLine` devolve a largura de uma linha já na fonte
 * do tamanho `fontSize` (no navegador, `ctx.measureText(line).width`).
 */
export function measureText(text: string, fontSize: number, measureLine: (line: string) => number): TextSize {
  const all = lines(text);
  const width = Math.max(0, ...all.map((l) => (l.length > 0 ? measureLine(l) : 0)));
  return { width, height: all.length * fontSize * LINE_HEIGHT };
}
