// Diagrama editável: o SVG que o Mermaid desenha vira elementos do quadro (retângulos,
// linhas, setas e textos), em vez de uma imagem só. Assim cada caixa pode ser movida,
// apagada ou ter o texto trocado como qualquer outro desenho.
//
// `extractShapes` lê o SVG já na página (precisa do navegador para medir caminhos e
// transformações); o resto são contas puras, testadas sem navegador.

export type Pt = [number, number];

export type DiagramShape =
  | { kind: 'rect'; x: number; y: number; width: number; height: number }
  | { kind: 'line'; points: Pt[]; head: boolean }
  | { kind: 'text'; text: string; cx: number; cy: number; fontSize: number };

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Douglas–Peucker: tira os pontos que quase não mudam o desenho da linha. */
export function simplify(points: readonly Pt[], tolerance: number): Pt[] {
  if (points.length <= 2) return points.map((p) => [p[0], p[1]]);
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let farDist = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = distanceToSegment(points[i]!, points[a]!, points[b]!);
      if (d > farDist) {
        far = i;
        farDist = d;
      }
    }
    if (far >= 0) {
      keep[far] = true;
      stack.push([a, far], [far, b]);
    }
  }
  return points.filter((_, i) => keep[i]).map((p) => [p[0], p[1]]);
}

function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Corta onde dois pontos seguidos estão longe demais: é um "pulo" de um caminho com
 * vários pedaços (`M ... M ...`), que não deve virar um risco ligando os dois.
 */
export function splitJumps(points: readonly Pt[], maxStep: number): Pt[][] {
  const parts: Pt[][] = [];
  let current: Pt[] = [];
  for (const p of points) {
    const last = current[current.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) > maxStep) {
      parts.push(current);
      current = [];
    }
    current.push(p);
  }
  parts.push(current);
  return parts.filter((part) => part.length >= 2);
}

/** Limites de todas as formas (o texto pelo tamanho medido, em `textSize`). */
export function shapesBounds(
  shapes: readonly DiagramShape[],
  textSize: (s: Extract<DiagramShape, { kind: 'text' }>) => { width: number; height: number },
): Box | null {
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (x: number, y: number) => {
    box.minX = Math.min(box.minX, x);
    box.minY = Math.min(box.minY, y);
    box.maxX = Math.max(box.maxX, x);
    box.maxY = Math.max(box.maxY, y);
  };
  for (const s of shapes) {
    if (s.kind === 'rect') {
      add(s.x, s.y);
      add(s.x + s.width, s.y + s.height);
    } else if (s.kind === 'line') {
      for (const [x, y] of s.points) add(x, y);
    } else {
      const { width, height } = textSize(s);
      add(s.cx - width / 2, s.cy - height / 2);
      add(s.cx + width / 2, s.cy + height / 2);
    }
  }
  return Number.isFinite(box.minX) ? box : null;
}

/** Leva a forma do espaço do SVG para o quadro: `world = (p - origin) * scale + offset`. */
export function transformShape(s: DiagramShape, origin: Pt, scale: number, offset: Pt): DiagramShape {
  const map = (x: number, y: number): Pt => [(x - origin[0]) * scale + offset[0], (y - origin[1]) * scale + offset[1]];
  if (s.kind === 'rect') {
    const [x, y] = map(s.x, s.y);
    return { kind: 'rect', x, y, width: s.width * scale, height: s.height * scale };
  }
  if (s.kind === 'line') return { kind: 'line', head: s.head, points: s.points.map(([x, y]) => map(x, y)) };
  const [cx, cy] = map(s.cx, s.cy);
  return { kind: 'text', text: s.text, cx, cy, fontSize: s.fontSize * scale };
}

/**
 * Tira traços repetidos. O Mermaid às vezes desenha o mesmo contorno mais de uma vez (uma
 * para o preenchimento, outra para a borda, ou em pedaços sobrepostos), o que no quadro
 * vira um traço dobrado e grosso. Uma linha sai quando todo o seu traço já passa a até
 * `tolerance` de linhas mais longas (ou bordas de retângulo) que ficaram. Textos iguais no
 * mesmo lugar também saem.
 */
export function dedupe(shapes: readonly DiagramShape[], tolerance = 3): DiagramShape[] {
  const segments: [Pt, Pt][] = [];
  const addOutline = (pts: readonly Pt[]) => {
    for (let i = 1; i < pts.length; i++) segments.push([pts[i - 1]!, pts[i]!]);
  };
  const keep = new Set<DiagramShape>();
  for (const s of shapes) {
    if (s.kind !== 'rect') continue;
    keep.add(s);
    addOutline(rectOutline(s));
  }
  // As mais longas primeiro: um pedaço curto some se já estiver dentro de uma longa.
  const lines = shapes.filter((s): s is Extract<DiagramShape, { kind: 'line' }> => s.kind === 'line');
  lines.sort((a, b) => length(b.points) - length(a.points));
  for (const line of lines) {
    // Seta nunca some: a ponta é informação que a outra linha pode não ter.
    if (!line.head && covered(line.points, segments, tolerance)) continue;
    keep.add(line);
    addOutline(line.points);
  }
  const texts: Extract<DiagramShape, { kind: 'text' }>[] = [];
  for (const s of shapes) {
    if (s.kind !== 'text') continue;
    if (texts.some((t) => t.text === s.text && Math.abs(t.cx - s.cx) <= tolerance && Math.abs(t.cy - s.cy) <= tolerance)) continue;
    texts.push(s);
    keep.add(s);
  }
  return shapes.filter((s) => keep.has(s));
}

function rectOutline(r: { x: number; y: number; width: number; height: number }): Pt[] {
  return [
    [r.x, r.y],
    [r.x + r.width, r.y],
    [r.x + r.width, r.y + r.height],
    [r.x, r.y + r.height],
    [r.x, r.y],
  ];
}

function length(points: readonly Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  return total;
}

/** O traço todo (amostrado a cada poucos pixels) passa perto de algum dos segmentos. */
function covered(points: readonly Pt[], segments: readonly [Pt, Pt][], tol: number): boolean {
  if (segments.length === 0) return false;
  const near = (p: Pt) => segments.some(([a, b]) => distanceToSegment(p, a, b) <= tol);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
    for (let k = i === 1 ? 0 : 1; k <= steps; k++) {
      const t = k / steps;
      if (!near([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) return false;
    }
  }
  return true;
}

/** Ordem de desenho: caixas atrás, linhas no meio, texto por cima. */
export function layerOrder(shapes: readonly DiagramShape[]): DiagramShape[] {
  const rank = { rect: 0, line: 1, text: 2 } as const;
  return [...shapes].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

// --- Leitura do SVG (navegador) ----------------------------------------------------------

/** Partes do SVG que não são desenho: pontas de seta (markers), definições, recortes. */
const SKIP = 'defs, marker, clipPath, mask, symbol, pattern, style, title, desc, foreignObject';
/** Passo da amostragem dos caminhos, em pixels do SVG. */
const SAMPLE_STEP = 3;
const SIMPLIFY_TOLERANCE = 0.6;
/**
 * Forma só com preenchimento (sem borda) entra apenas se for pequena, como a bolinha de
 * início de um diagrama de estados. As grandes são fundos de linha ou de caixa.
 */
const MAX_FILL_ONLY = 30;

/**
 * Lê o SVG (que precisa estar na página; pode estar fora da tela ou transparente) e
 * devolve as formas nas coordenadas da própria imagem, em pixels.
 */
export function extractShapes(svg: SVGSVGElement): DiagramShape[] {
  const origin = svg.getBoundingClientRect();
  const toLocal = (el: SVGGraphicsElement) => {
    const m = el.getScreenCTM();
    return (x: number, y: number): Pt => {
      if (!m) return [x, y];
      return [m.a * x + m.c * y + m.e - origin.left, m.b * x + m.d * y + m.f - origin.top];
    };
  };
  const shapes: DiagramShape[] = [];

  for (const el of svg.querySelectorAll<SVGElement>('rect, path, line, polyline, polygon, circle, ellipse, text')) {
    if (el.closest(SKIP)) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;

    if (el instanceof SVGTextElement) {
      const text = textOf(el);
      if (!text) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const m = el.getScreenCTM();
      const scale = m ? Math.hypot(m.a, m.b) : 1;
      shapes.push({
        kind: 'text',
        text,
        cx: r.left + r.width / 2 - origin.left,
        cy: r.top + r.height / 2 - origin.top,
        fontSize: (parseFloat(style.fontSize) || 16) * scale,
      });
      continue;
    }

    if (!(el instanceof SVGGeometryElement)) continue;
    const stroked = style.stroke !== 'none' && parseFloat(style.strokeWidth) > 0 && Number(style.strokeOpacity) !== 0;
    const filled = style.fill !== 'none' && Number(style.fillOpacity) !== 0;
    // Retângulo só com preenchimento é fundo de rótulo: o texto já basta.
    if (el instanceof SVGRectElement && !stroked) continue;
    if (!stroked && !filled) continue;

    if (!stroked) {
      const r = el.getBoundingClientRect();
      if (r.width > MAX_FILL_ONLY || r.height > MAX_FILL_ONLY) continue;
    }

    const local = toLocal(el);
    if (el instanceof SVGRectElement) {
      const rect = axisAlignedRect(el, local);
      if (rect) {
        if (rect.width > 0.5 && rect.height > 0.5) shapes.push(rect);
        continue;
      }
    }

    let length = 0;
    try {
      length = el.getTotalLength();
    } catch {
      continue;
    }
    if (!(length > 0.5)) continue;
    const count = Math.min(600, Math.max(2, Math.ceil(length / SAMPLE_STEP)));
    const samples: Pt[] = [];
    for (let i = 0; i <= count; i++) {
      const p = el.getPointAtLength((length * i) / count);
      samples.push(local(p.x, p.y));
    }
    const step = (length / count) * scaleOf(el);
    const head = hasArrowHead(el, style);
    const parts = splitJumps(samples, Math.max(step * 2.5, 2));
    parts.forEach((part, i) => {
      const points = simplify(part, SIMPLIFY_TOLERANCE);
      // A ponta de seta vai só no último pedaço, que é onde o caminho termina.
      if (points.length >= 2) shapes.push({ kind: 'line', points, head: head && i === parts.length - 1 });
    });
  }
  return dedupe(shapes);
}

function scaleOf(el: SVGGraphicsElement): number {
  const m = el.getScreenCTM();
  return m ? Math.hypot(m.a, m.b) : 1;
}

/** Retângulo sem rotação, em coordenadas da imagem; `null` se estiver girado. */
function axisAlignedRect(el: SVGRectElement, local: (x: number, y: number) => Pt): Extract<DiagramShape, { kind: 'rect' }> | null {
  const x = el.x.baseVal.value;
  const y = el.y.baseVal.value;
  const w = el.width.baseVal.value;
  const h = el.height.baseVal.value;
  const a = local(x, y);
  const b = local(x + w, y);
  const c = local(x + w, y + h);
  if (Math.abs(a[1] - b[1]) > 0.01 || Math.abs(b[0] - c[0]) > 0.01) return null;
  return {
    kind: 'rect',
    x: Math.min(a[0], c[0]),
    y: Math.min(a[1], c[1]),
    width: Math.abs(c[0] - a[0]),
    height: Math.abs(c[1] - a[1]),
  };
}

/** Texto em linhas: o Mermaid põe cada linha num `tspan` filho direto do `text`. */
function textOf(el: SVGTextElement): string {
  const rows = [...el.children].filter((c) => c.tagName.toLowerCase() === 'tspan');
  const lines = rows.length > 0 ? rows.map((r) => normalizeSpaces(r.textContent ?? '')) : [normalizeSpaces(el.textContent ?? '')];
  return lines.filter((l) => l.length > 0).join('\n');
}

function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** A linha termina numa ponta de seta (e não num losango, círculo ou "pé de galinha"). */
function hasArrowHead(el: SVGElement, style: CSSStyleDeclaration): boolean {
  const marker = el.getAttribute('marker-end') || style.getPropertyValue('marker-end');
  if (!marker || marker === 'none') return false;
  return /point|arrow|barb|filled-head|head/i.test(marker) && !/circle|cross|diamond|aggregation|composition|one|many|zero/i.test(marker);
}
