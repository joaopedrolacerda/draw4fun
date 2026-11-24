import { describe, expect, it } from 'vitest';
import { BLANK_PLAIN, PLAIN_EXAMPLES, plainToMermaid } from './plainDiagram';

/** Linhas do código, sem o recuo. */
function lines(code: string): string[] {
  return code.split('\n').map((l) => l.trim());
}

describe('texto simples para Mermaid', () => {
  it('passos em fila viram um fluxograma de cima para baixo', () => {
    expect(lines(plainToMermaid('Acordar\nTomar café\nTrabalhar'))).toEqual([
      'flowchart TD',
      'n1["Acordar"]',
      'n2["Tomar café"]',
      'n3["Trabalhar"]',
      'n1 --> n2',
      'n2 --> n3',
    ]);
  });

  it('pergunta vira decisão, respostas recuadas viram caminhos e se juntam no próximo passo', () => {
    const code = plainToMermaid(`Pedido
Tem estoque?
  sim: Separar
  não: Avisar o cliente
Fim`);
    expect(lines(code)).toEqual([
      'flowchart TD',
      'n1["Pedido"]',
      'n2{"Tem estoque?"}',
      'n3["Separar"]',
      'n4["Avisar o cliente"]',
      'n5(["Fim"])',
      'n1 --> n2',
      'n2 -->|"sim"| n3',
      'n2 -->|"não"| n4',
      'n3 --> n5',
      'n4 --> n5',
    ]);
  });

  it('"se" com respostas embaixo também é decisão, e ganha o ponto de interrogação', () => {
    const code = plainToMermaid('se tem massa\n  sim: Assar\n  senão: Fazer a massa');
    expect(code).toContain('n1{"Tem massa?"}');
    expect(code).toContain('n1 -->|"não"| n3');
  });

  it('"se" sem respostas é um passo comum', () => {
    expect(plainToMermaid('Se inscrever no curso')).toContain('n1["Se inscrever no curso"]');
  });

  it('linhas mais recuadas continuam o caminho da resposta', () => {
    const code = plainToMermaid(`Tem massa?
  sim: Assar
  não: Fazer a massa
    Esperar crescer
    Assar
Entregar`);
    expect(lines(code)).toEqual([
      'flowchart TD',
      'n1{"Tem massa?"}',
      'n2["Assar"]',
      'n3["Fazer a massa"]',
      'n4["Esperar crescer"]',
      'n5["Entregar"]',
      'n1 -->|"sim"| n2',
      'n1 -->|"não"| n3',
      'n3 --> n4',
      'n4 --> n2',
      'n2 --> n5',
    ]);
  });

  it('uma resposta só deixa o outro caminho seguir direto', () => {
    const code = plainToMermaid('Chovendo?\n  sim: Pegar guarda-chuva\nSair');
    expect(code).toContain('n1 -->|"sim"| n2');
    expect(code).toContain('n2 --> n3');
    expect(code).toContain('n1 -->|"não"| n3');
  });

  it('"volta para" liga num passo já escrito e encerra o caminho', () => {
    const code = plainToMermaid(PLAIN_EXAMPLES.find((e) => e.id === 'loop')?.text ?? '');
    expect(code).toContain('n1(["Início"])');
    expect(code).toContain('n4 -->|"não"| n2');
    expect(code).toContain('n4 -->|"sim"| n5');
    expect(code).not.toContain('n2 -->|"não"| n5');
  });

  it('o mesmo texto é o mesmo passo, sem diferença de maiúsculas e ponto final', () => {
    const code = plainToMermaid('Ler\nEscrever\nler.');
    expect(code).toContain('n2 --> n1');
    expect(code).not.toContain('n3');
  });

  it('"fim" encerra: nada sai dele', () => {
    const code = plainToMermaid('Começo\nFim\nDepois');
    expect(code).toContain('n1(["Começo"])');
    expect(code).toContain('n2(["Fim"])');
    expect(code).not.toContain('n2 --> n3');
  });

  it('setas numa linha só ligam em fila', () => {
    expect(lines(plainToMermaid('A -> B → C'))).toEqual(['flowchart TD', 'n1["A"]', 'n2["B"]', 'n3["C"]', 'n1 --> n2', 'n2 --> n3']);
  });

  it('direção, notas e linhas vazias', () => {
    const code = plainToMermaid('direção: horizontal\n# uma nota\n\nA\n// outra\nB');
    expect(lines(code)).toEqual(['flowchart LR', 'n1["A"]', 'n2["B"]', 'n1 --> n2']);
  });

  it('aspas e tabulação não quebram o código', () => {
    const code = plainToMermaid('Ler "manual"?\n\tsim: Ok');
    expect(code).toContain('n1{"Ler #quot;manual#quot;?"}');
    expect(code).toContain('n1 -->|"sim"| n2');
  });

  it('toda linha "Quem -> Para quem: mensagem" vira diagrama de sequência', () => {
    const code = plainToMermaid(PLAIN_EXAMPLES.find((e) => e.id === 'sequence')?.text ?? '');
    expect(lines(code)).toEqual([
      'sequenceDiagram',
      'participant p1 as Cliente',
      'participant p2 as App',
      'participant p3 as API',
      'p1->>p2: Faz login',
      'p2->>p3: Envia usuário e senha',
      'p3-->>p2: Token de acesso',
      'p2-->>p1: Mostra a tela inicial',
    ]);
  });

  it('sequência protege ; e # da mensagem', () => {
    expect(plainToMermaid('A -> B: um; dois #3')).toContain('p1->>p2: um#59; dois #35;3');
  });

  it('uma linha fora do jeito de mensagem mantém o fluxograma', () => {
    expect(plainToMermaid('A -> B: oi\nC').startsWith('flowchart')).toBe(true);
  });

  it('texto vazio pede um passo', () => {
    expect(() => plainToMermaid('  \n# só nota\n')).toThrow('Escreva pelo menos um passo');
  });

  it('todos os exemplos traduzem', () => {
    expect(BLANK_PLAIN.length).toBeGreaterThan(0);
    for (const example of PLAIN_EXAMPLES) expect(() => plainToMermaid(example.text)).not.toThrow();
  });
});
