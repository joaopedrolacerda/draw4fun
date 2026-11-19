// Diagramas em Mermaid: o texto vira um SVG (com a biblioteca oficial do Mermaid) e entra
// no quadro como imagem. A biblioteca é grande, então só é baixada na primeira vez que
// alguém abre a janela de diagrama.
//
// O SVG leva a fonte Kalam embutida: desenhado como imagem, ele não enxerga as fontes da
// página, e sem isso o texto sairia numa fonte diferente da que o Mermaid usou para medir.

import kalamUrl from '@fontsource/kalam/files/kalam-latin-400-normal.woff2?url';
import { type LoadedImage, fileIdFor } from './images';

export interface DiagramTemplate {
  id: string;
  label: string;
  description: string;
  code: string;
}

/** Os cinco tipos de diagrama mais usados, com um exemplo pronto de cada. */
export const TEMPLATES: readonly DiagramTemplate[] = [
  {
    id: 'flowchart',
    label: 'Fluxograma',
    description: 'Passos e decisões',
    code: `flowchart TD
    A[Pedido recebido] --> B{Tem estoque?}
    B -->|Sim| C[Separar produtos]
    B -->|Não| D[Avisar o cliente]
    C --> E[Enviar]
    D --> F([Fim])
    E --> F`,
  },
  {
    id: 'sequence',
    label: 'Sequência',
    description: 'Mensagens entre participantes',
    code: `sequenceDiagram
    actor Cliente
    participant App
    participant API
    Cliente->>App: Faz login
    App->>API: Envia usuário e senha
    API-->>App: Token de acesso
    App-->>Cliente: Mostra a tela inicial`,
  },
  {
    id: 'class',
    label: 'Classes',
    description: 'Estrutura de objetos',
    code: `classDiagram
    class Pedido {
      +int numero
      +Date data
      +total() float
    }
    class Cliente {
      +String nome
      +String email
    }
    class Item {
      +String produto
      +int quantidade
    }
    Cliente "1" --> "*" Pedido : faz
    Pedido "1" *-- "*" Item : contém`,
  },
  {
    id: 'state',
    label: 'Estados',
    description: 'Ciclo de vida de algo',
    code: `stateDiagram-v2
    [*] --> Rascunho
    Rascunho --> EmRevisao: enviar
    EmRevisao --> Rascunho: pedir ajustes
    EmRevisao --> Publicado: aprovar
    Publicado --> Arquivado: arquivar
    Arquivado --> [*]`,
  },
  {
    id: 'er',
    label: 'Entidade-relacionamento',
    description: 'Tabelas de um banco de dados',
    code: `erDiagram
    CLIENTE ||--o{ PEDIDO : faz
    PEDIDO ||--|{ ITEM : contem
    PRODUTO ||--o{ ITEM : aparece_em
    CLIENTE {
      int id
      string nome
      string email
    }
    PEDIDO {
      int id
      date data
    }
    PRODUTO {
      int id
      string nome
      float preco
    }`,
  },
];

/** Ponto de partida de um diagrama em branco. */
export const BLANK_DIAGRAM = `flowchart LR
    A[Comece aqui] --> B[Próximo passo]`;

export const DIAGRAM_FONT = 'Kalam';

/** Tamanho pelo `viewBox` do SVG (o Mermaid escreve `width="100%"`, que não serve de medida). */
export function svgSize(svg: string): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  const box = root && /viewBox="\s*([-\d.e]+)[\s,]+([-\d.e]+)[\s,]+([-\d.e]+)[\s,]+([-\d.e]+)\s*"/i.exec(root);
  if (!box) return null;
  const width = Number(box[3]);
  const height = Number(box[4]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Deixa o SVG pronto para virar imagem: largura e altura fixas (as do `viewBox`), sem o
 * `max-width` do estilo, e com a fonte embutida (`fontCss`, um `@font-face`).
 */
export function prepareSvg(svg: string, fontCss: string): { svg: string; width: number; height: number } {
  const size = svgSize(svg);
  if (!size) throw new Error('O Mermaid devolveu um desenho sem tamanho.');
  const { width, height } = size;
  const fixed = svg.replace(/<svg\b[^>]*>/i, (tag) => {
    const clean = tag
      .replace(/\swidth="[^"]*"/i, '')
      .replace(/\sheight="[^"]*"/i, '')
      .replace(/\sstyle="[^"]*"/i, '');
    const style = fontCss ? `<style>${fontCss}</style>` : '';
    return `${clean.slice(0, -1)} width="${width}" height="${height}">${style}`;
  });
  return { svg: fixed, width, height };
}

/** `data:image/svg+xml;base64,...`, com o texto em UTF-8 (acentos inclusos). */
export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** Erro do Mermaid em português, com a linha quando ele informa. */
export function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const line = /line (\d+)/i.exec(raw)?.[1];
  if (/No diagram type detected|UnknownDiagramError/i.test(raw)) {
    return 'A primeira linha precisa dizer o tipo do diagrama, por exemplo "flowchart TD" ou "sequenceDiagram".';
  }
  if (line) return `Linha ${line}: o Mermaid não entendeu esta linha.`;
  return 'O Mermaid não conseguiu desenhar esse texto.';
}

type MermaidApi = typeof import('mermaid').default;
let api: Promise<MermaidApi> | null = null;
let fontCss: Promise<string> | null = null;
let counter = 0;

function loadMermaid(): Promise<MermaidApi> {
  api ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'neutral',
      look: 'handDrawn',
      handDrawnSeed: 1,
      fontFamily: `${DIAGRAM_FONT}, cursive`,
      // Texto como SVG puro: rótulos em HTML (foreignObject) não aparecem quando o SVG é imagem.
      htmlLabels: false,
    });
    return mermaid;
  });
  api.catch(() => (api = null));
  return api;
}

function loadFontCss(): Promise<string> {
  fontCss ??= (async () => {
    try {
      const blob = await (await fetch(kalamUrl)).blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('vazio')));
        reader.onerror = () => reject(reader.error ?? new Error('falhou'));
        reader.readAsDataURL(blob);
      });
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      return `@font-face{font-family:'${DIAGRAM_FONT}';src:url(data:font/woff2;base64,${base64}) format('woff2');}`;
    } catch {
      // Sem a fonte embutida o diagrama ainda sai, só com a letra do sistema.
      return '';
    }
  })();
  return fontCss;
}

/**
 * Desenha o texto em Mermaid e devolve pronto para entrar no quadro como imagem.
 * Lança erro com mensagem em português se o texto não puder ser desenhado.
 */
export async function renderMermaid(code: string): Promise<LoadedImage> {
  if (code.trim().length === 0) throw new Error('Escreva o diagrama primeiro.');
  const [mermaid, css] = await Promise.all([loadMermaid(), loadFontCss(), document.fonts?.load(`16px ${DIAGRAM_FONT}`)]);
  const id = `draw4fun-mermaid-${++counter}`;
  try {
    await mermaid.parse(code);
    const { svg } = await mermaid.render(id, code);
    const ready = prepareSvg(svg, css);
    const dataUrl = svgDataUrl(ready.svg);
    return { fileId: await fileIdFor(dataUrl), mimeType: 'image/svg+xml', dataUrl, width: ready.width, height: ready.height };
  } catch (err) {
    throw new Error(describeError(err), { cause: err });
  } finally {
    // Em caso de erro o Mermaid pode deixar o rascunho do desenho na página.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}
