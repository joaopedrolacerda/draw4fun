// Cores de fundo do quadro e como a tinta se adapta a elas.
//
// A cor do fundo fica no próprio arquivo (vai junto pelo Drive). A tinta guardada nos
// elementos não muda: só na hora de desenhar, tinta escura sobre fundo escuro vira clara
// (e o contrário), para o desenho não sumir ao trocar o fundo.

export interface BackgroundChoice {
  label: string;
  color: string;
}

export const BACKGROUNDS: readonly BackgroundChoice[] = [
  { label: 'Branco', color: '#fbfaf7' },
  { label: 'Preto', color: '#1c1c1e' },
  { label: 'Amarelo', color: '#fdf0a6' },
];

export const DEFAULT_BACKGROUND = BACKGROUNDS[0]!.color;

/** Tinta clara usada no lugar da escura quando o fundo é escuro. */
const LIGHT_INK = '#f4f2ec';
/** Tinta escura usada no lugar da clara quando o fundo é claro. */
const DARK_INK = '#1f2933';

/** Luminância relativa (0 a 1) de uma cor `#rgb` ou `#rrggbb`; `null` se não entender. */
export function luminance(color: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  let hex = m[1]!;
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

export function isDark(color: string): boolean {
  return (luminance(color) ?? 1) < 0.2;
}

/**
 * Cor em que a tinta aparece sobre o fundo: troca só quando quase não daria para ver
 * (preto no preto, branco no branco ou no amarelo). As outras cores ficam como estão.
 */
export function displayInk(ink: string, background: string): string {
  const l = luminance(ink);
  if (l === null) return ink;
  if (isDark(background)) return l < 0.05 ? LIGHT_INK : ink;
  return l > 0.85 ? DARK_INK : ink;
}

/** Cor dos pontinhos da grade, visível mas discreta em cada fundo. */
export function gridDotColor(background: string): string {
  return isDark(background) ? 'rgba(255, 255, 255, 0.16)' : 'rgba(60, 50, 30, 0.16)';
}
