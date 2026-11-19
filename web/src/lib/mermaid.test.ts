import { describe, expect, it } from 'vitest';
import { BLANK_DIAGRAM, TEMPLATES, describeError, prepareSvg, svgDataUrl, svgSize } from './mermaid';

const MERMAID_SVG =
  '<svg id="m1" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 320.5px;" viewBox="-8 -8 320.5 180" role="graphics-document"><g><text>Olá</text></g></svg>';

describe('mermaid', () => {
  it('tem os cinco tipos mais usados, cada um começando pela palavra do tipo', () => {
    expect(TEMPLATES.map((t) => t.label)).toEqual(['Fluxograma', 'Sequência', 'Classes', 'Estados', 'Entidade-relacionamento']);
    const keywords = TEMPLATES.map((t) => t.code.split('\n')[0]?.split(' ')[0]);
    expect(keywords).toEqual(['flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram-v2', 'erDiagram']);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(5);
    expect(BLANK_DIAGRAM.startsWith('flowchart')).toBe(true);
  });

  it('lê o tamanho pelo viewBox', () => {
    expect(svgSize(MERMAID_SVG)).toEqual({ width: 320.5, height: 180 });
    expect(svgSize('<svg width="10"></svg>')).toBeNull();
    expect(svgSize('<svg viewBox="0 0 0 10"></svg>')).toBeNull();
  });

  it('fixa largura e altura, tira o max-width e embute a fonte', () => {
    const ready = prepareSvg(MERMAID_SVG, '@font-face{font-family:X}');
    expect(ready).toMatchObject({ width: 320.5, height: 180 });
    expect(ready.svg).toContain('width="320.5" height="180"><style>@font-face{font-family:X}</style><g>');
    expect(ready.svg).not.toContain('100%');
    expect(ready.svg).not.toContain('max-width');
    expect(ready.svg).toContain('viewBox="-8 -8 320.5 180"');
    expect(() => prepareSvg('<svg></svg>', '')).toThrow();
  });

  it('data URL guarda acentos em UTF-8', () => {
    const url = svgDataUrl('<svg>Olá, ação</svg>');
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const bytes = Uint8Array.from(atob(url.split(',')[1] ?? ''), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe('<svg>Olá, ação</svg>');
  });

  it('erros viram mensagens em português', () => {
    expect(describeError(new Error('Parse error on line 3:\n...A -->\n------^\nExpecting ...'))).toBe(
      'Linha 3: o Mermaid não entendeu esta linha.',
    );
    expect(describeError(new Error('No diagram type detected matching given configuration for text: oi'))).toMatch(
      /primeira linha/,
    );
    expect(describeError('estranho')).toBe('O Mermaid não conseguiu desenhar esse texto.');
  });
});
