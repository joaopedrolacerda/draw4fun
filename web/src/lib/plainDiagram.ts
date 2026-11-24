// Diagrama em texto simples: a pessoa escreve os passos em português, um por linha, e as
// regras daqui (sem IA, sempre o mesmo resultado para o mesmo texto) montam o código Mermaid.
//
// Fluxograma (o padrão):
//   - Cada linha é um passo, ligado ao passo de cima.
//   - Linha que termina em "?" é uma decisão ("se ..." com respostas embaixo também é).
//     As respostas vêm embaixo, com recuo: "sim: Assar". O que vem mais recuado embaixo de
//     uma resposta continua aquele caminho. Depois das respostas, os caminhos se juntam no
//     próximo passo sem recuo. Só "sim" (ou só "não") deixa o outro caminho seguir direto.
//   - "fim" termina o caminho; "início"/"começo" viram a forma arredondada.
//   - O mesmo texto é o mesmo passo, então repetir um passo já escrito liga nele.
//     "volta para X" (ou "vai para X") liga em X e encerra aquele caminho.
//   - "A -> B -> C" numa linha só liga os passos em fila.
//   - "direção: horizontal" (ou "vertical") escolhe o sentido. Linhas com # ou // são notas.
//
// Sequência: quando toda linha tem o jeito "Quem -> Para quem: mensagem", o diagrama vira de
// sequência. "-->" é resposta (linha tracejada).

export interface PlainExample {
  id: string;
  label: string;
  text: string;
}

/** Exemplos para a janela de diagrama, um de cada tipo que o texto simples entende. */
export const PLAIN_EXAMPLES: readonly PlainExample[] = [
  {
    id: 'flow',
    label: 'Fluxograma',
    text: `Cliente pede pizza
Restaurante confirma o pedido
Tem massa pronta?
  sim: Assar
  não: Fazer a massa
    Esperar crescer
    Assar
Entregar
Fim`,
  },
  {
    id: 'loop',
    label: 'Repetição',
    text: `Início
Escrever o texto
Revisar
Está bom?
  não: volta para Escrever o texto
Publicar`,
  },
  {
    id: 'sequence',
    label: 'Sequência',
    text: `Cliente -> App: Faz login
App -> API: Envia usuário e senha
API --> App: Token de acesso
App --> Cliente: Mostra a tela inicial`,
  },
];

/** Ponto de partida do texto simples. */
export const BLANK_PLAIN = PLAIN_EXAMPLES[0]?.text ?? '';

interface Line {
  text: string;
  indent: number;
  children: Line[];
}

/** Saída de um passo, esperando o próximo: de onde a seta parte e o rótulo dela. */
interface Exit {
  from: string;
  label?: string;
}

type Shape = 'step' | 'decision' | 'terminal';

const TAB_WIDTH = 4;
const COMMENT = /^(#|\/\/)/;
const DIRECTION = /^dire[cç][aã]o\s*:\s*(horizontal|vertical|lado a lado|de lado|para baixo)\s*$/i;
const GOTO = /^(?:volta(?:r)?|vai|ir)\s+(?:para|pra|ao|à|a)\s+(.+)$/i;
const TERMINAL = /^(fim|início|inicio|começo|comeco|começar|comecar|terminar|acabou)\.?$/i;
const CHAIN = /\s*(?:->|→)\s*/;
const MESSAGE = /^(.+?)\s*(-->|->|→)\s*(.+?)\s*:\s*(.*)$/;
const IF_PREFIX = /^se\s+/i;
const LABEL = /^([^:]{1,40}):\s*(.*)$/;

/**
 * Traduz o texto simples para código Mermaid (fluxograma ou sequência, pelo jeito das
 * linhas). Lança erro com mensagem em português se não houver nada para desenhar.
 */
export function plainToMermaid(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((raw) => ({ raw, trimmed: raw.trim() }))
    .filter(({ trimmed }) => trimmed.length > 0 && !COMMENT.test(trimmed));
  if (lines.length === 0) throw new Error('Escreva pelo menos um passo, um por linha.');

  const messages = lines.map(({ trimmed }) => MESSAGE.exec(trimmed));
  if (messages.every((m) => m !== null)) return sequence(messages.filter((m) => m !== null));

  let direction = 'TD';
  const content: { raw: string; trimmed: string }[] = [];
  for (const line of lines) {
    const dir = DIRECTION.exec(line.trimmed);
    if (dir) direction = /vertical|baixo/i.test(dir[1] ?? '') ? 'TD' : 'LR';
    else content.push(line);
  }
  if (content.length === 0) throw new Error('Escreva pelo menos um passo, um por linha.');
  return new Flowchart(direction).build(tree(content));
}

function indentOf(raw: string): number {
  let width = 0;
  for (const ch of raw) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += TAB_WIDTH;
    else break;
  }
  return width;
}

/** Linhas viram árvore pelo recuo: mais recuada que a de cima é filha dela. */
function tree(lines: { raw: string; trimmed: string }[]): Line[] {
  const root: Line = { text: '', indent: -1, children: [] };
  const stack: Line[] = [root];
  for (const { raw, trimmed } of lines) {
    const line: Line = { text: trimmed, indent: indentOf(raw), children: [] };
    while (stack.length > 1 && (stack[stack.length - 1]?.indent ?? -1) >= line.indent) stack.pop();
    stack[stack.length - 1]?.children.push(line);
    stack.push(line);
  }
  return root.children;
}

/** Texto entre aspas do Mermaid: aspas viram código de entidade. */
function quote(text: string): string {
  return `"${text.replace(/"/g, '#quot;')}"`;
}

function stripEnd(text: string): string {
  return text.replace(/[.;,]+$/, '').trim();
}

/** "Não" e "senão" são o mesmo caminho. */
function normalizeLabel(label: string): string {
  const clean = label.trim();
  return /^(sen[aã]o|se n[aã]o|caso contr[aá]rio)$/i.test(clean) ? 'não' : clean;
}

class Flowchart {
  private readonly ids = new Map<string, string>();
  private readonly nodes: string[] = [];
  private readonly edges: string[] = [];
  private readonly edgeKeys = new Set<string>();

  constructor(private readonly direction: string) {}

  build(lines: Line[]): string {
    this.list(lines, []);
    return [`flowchart ${this.direction}`, ...this.nodes, ...this.edges].map((l, i) => (i === 0 ? l : `    ${l}`)).join('\n');
  }

  /** Mesmo texto, mesmo passo (sem diferença de maiúsculas e pontuação no fim). */
  private node(text: string, shape: Shape): string {
    const key = text.toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ');
    const existing = this.ids.get(key);
    if (existing) return existing;
    const id = `n${this.ids.size + 1}`;
    this.ids.set(key, id);
    const label = quote(text);
    this.nodes.push(shape === 'decision' ? `${id}{${label}}` : shape === 'terminal' ? `${id}([${label}])` : `${id}[${label}]`);
    return id;
  }

  private connect(from: Exit[], to: string): void {
    for (const exit of from) {
      const label = exit.label ? `|${quote(exit.label)}|` : '';
      const key = `${exit.from}>${to}>${exit.label ?? ''}`;
      if (this.edgeKeys.has(key)) continue;
      this.edgeKeys.add(key);
      this.edges.push(`${exit.from} -->${label} ${to}`);
    }
  }

  private list(lines: Line[], incoming: Exit[]): Exit[] {
    return lines.reduce((exits, line) => this.item(line.text, line.children, exits), incoming);
  }

  private item(rawText: string, children: Line[], incoming: Exit[]): Exit[] {
    const text = rawText.trim();

    const go = GOTO.exec(text);
    if (go) {
      const target = stripEnd(go[1] ?? '');
      if (target) this.connect(incoming, this.node(target, TERMINAL.test(target) ? 'terminal' : 'step'));
      return [];
    }

    const parts = text.split(CHAIN).filter((p) => p.length > 0);
    if (parts.length > 1) {
      const last = parts.pop() ?? '';
      const before = parts.reduce((exits, part) => this.item(part, [], exits), incoming);
      return this.item(last, children, before);
    }

    const isDecision = text.endsWith('?') || (IF_PREFIX.test(text) && children.length > 0);
    if (isDecision) return this.decision(text, children, incoming);

    const clean = stripEnd(text);
    if (!clean) return incoming;
    const terminal = TERMINAL.test(clean);
    const id = this.node(clean, terminal ? 'terminal' : 'step');
    this.connect(incoming, id);
    if (terminal && /^fim|^terminar|^acabou/i.test(clean)) return [];
    return this.list(children, [{ from: id }]);
  }

  private decision(text: string, children: Line[], incoming: Exit[]): Exit[] {
    let question = text.replace(IF_PREFIX, '').trim();
    if (!question.endsWith('?')) question = `${stripEnd(question)}?`;
    question = question.charAt(0).toLocaleUpperCase('pt-BR') + question.slice(1);
    const id = this.node(question, 'decision');
    this.connect(incoming, id);
    if (children.length === 0) return [{ from: id }];

    const exits: Exit[] = [];
    const labels: string[] = [];
    for (const child of children) {
      const match = LABEL.exec(child.text);
      if (match && !GOTO.test(child.text)) {
        const label = normalizeLabel(match[1] ?? '');
        labels.push(label.toLocaleLowerCase('pt-BR'));
        const rest = (match[2] ?? '').trim();
        const start: Exit[] = [{ from: id, label }];
        exits.push(...(rest ? this.item(rest, child.children, start) : child.children.length > 0 ? this.list(child.children, start) : start));
      } else {
        labels.push('');
        exits.push(...this.item(child.text, child.children, [{ from: id }]));
      }
    }

    // Uma resposta só: o outro caminho segue direto para o próximo passo.
    if (children.length === 1) {
      const only = labels[0];
      exits.push(only === 'sim' ? { from: id, label: 'não' } : only === 'não' ? { from: id, label: 'sim' } : { from: id });
    }
    return exits;
  }
}

function sequence(messages: RegExpExecArray[]): string {
  const ids = new Map<string, string>();
  const participants: string[] = [];
  const participant = (name: string): string => {
    const clean = name.trim().replace(/;/g, ',');
    const key = clean.toLocaleLowerCase('pt-BR');
    const existing = ids.get(key);
    if (existing) return existing;
    const id = `p${ids.size + 1}`;
    ids.set(key, id);
    participants.push(`participant ${id} as ${clean}`);
    return id;
  };
  const lines = messages.map((m) => {
    const from = participant(m[1] ?? '');
    const to = participant(m[3] ?? '');
    const arrow = m[2] === '-->' ? '-->>' : '->>';
    const text = (m[4] ?? '').trim().replace(/[#;]/g, (ch) => (ch === '#' ? '#35;' : '#59;'));
    return `${from}${arrow}${to}: ${text || ' '}`;
  });
  return ['sequenceDiagram', ...participants, ...lines].map((l, i) => (i === 0 ? l : `    ${l}`)).join('\n');
}
