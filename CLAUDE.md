# draw4fun

Quadro branco com traço de esboço: formas que parecem feitas à mão, traço livre e canvas infinito.
O app é original: a ideia é a mesma de outros quadros de esboço, mas sem copiar nome, marca nem visual de nenhum.
Interface e textos em português do Brasil.

## Partes
| Pasta | O que é |
|---|---|
| `core/` | Crate Rust `draw4fun-core`: modelo do documento, geometria, traço de esboço, JSON e merge. Sem dependência de plataforma. |
| `core-wasm/` | Ponte wasm-bindgen para a web. Só traduz tipos; regra nenhuma aqui. |
| `web/` | Site: Vite + Svelte 5 + TypeScript. O canvas usa Canvas 2D. |
| `fixtures/` | JSON de exemplo lido pelos testes do Rust e do TS. |

Ordem do projeto: web primeiro, com login Google e sincronização no Drive; depois o app Swift
(iOS, iPadOS, macOS), que vai usar o mesmo `core` pelo UniFFI (`core-ffi/`, ainda não existe).

## Regras
- **Toda mudança vem com testes, e todos precisam passar.**
- Regra de desenho, geometria, formato do arquivo e merge ficam no `core`. A web e o app não reimplementam.
- O formato do arquivo tem `schemaVersion`. Mudou de um jeito que versões antigas não leem: suba a versão e escreva a migração em `Document::from_json`.
- Texto: a plataforma mede (largura e altura) e grava no elemento; o núcleo usa a medida para clique e limites.
- Imagens ficam dentro do arquivo, em `files`, como data URL, com chave pelo SHA-256 do conteúdo (a mesma imagem colada duas vezes ocupa espaço uma vez). Imagens com mais de 2048 px ou 1,5 MB são reduzidas antes de entrar.
- Copiar e colar: a área de transferência recebe um JSON marcado com `"type": "draw4fun/clipboard"`, com os elementos e as imagens que eles usam, então funciona entre abas e entre desenhos. A cópia ganha id novo e mantém a semente (o rabisco sai igual). Ctrl/Cmd+C e X são tratados na tecla (`document.execCommand('copy')`, com a API de área de transferência como plano B), porque o Safari nem sempre dispara `copy` sem texto selecionado.
- Desfazer/refazer fica no núcleo (`core/src/history.rs`). Toda operação que muda um elemento chama `record` antes de mudar; o editor chama `endStep` ao fim de cada gesto, então um gesto inteiro vira um passo. Desfazer grava o conteúdo antigo como mudança nova (versão maior), para o merge não confundir com uma cópia velha. Operação nova no `Board` que muda elemento precisa chamar `record`/`record_new`.
- Drive: escopo `drive.file`, login por redirecionamento no navegador (token de ~1 h no `sessionStorage`, sem servidor). Não use o login por pop-up do Google Identity Services: a política de segurança da página do Google faz a biblioteca avisar "janela fechada" com a janela aberta e o login trava. O ID do cliente vem de `VITE_GOOGLE_CLIENT_ID` em `web/.env.local` (fora do git); sem ele, o Drive fica escondido. Roteiro do Google Cloud no README.
- Mudança vinda do Drive entra por `editor.mergeRemote` (evento `onRemoteChange`), que não marca o quadro como mudado localmente: senão cada download viraria um novo envio.
- Seta é uma lista de pontos (`points: [[x, y], ...]`, ponta no último): a ferramenta faz setas retas de dois pontos; mais pontos fazem dobras. Boneco (`figure`) é uma caixa onde o núcleo desenha cabeça, tronco, braços e pernas.
- Diagramas usam a biblioteca oficial do Mermaid (`web/src/lib/mermaid.ts`), baixada só quando a janela de diagrama abre. O texto vira SVG (visual `handDrawn`, rótulos em SVG puro com `htmlLabels: false`, fonte Kalam embutida em `@font-face`) e entra no quadro como imagem `image/svg+xml`: não é editável por partes; para mudar, edita o código e insere de novo. Os modelos (fluxograma, sequência, classes, estados, entidade-relacionamento) ficam em `TEMPLATES`.
- O app se chamava Rabisco. Dados com os nomes antigos continuam valendo e são migrados sozinhos: chaves `rabisco:*` do navegador e o banco `rabisco` do IndexedDB (ao abrir a página), a pasta "Rabisco" e o arquivo "Meu quadro.rabisco" com a marca `rabisco=board` no Drive (renomeados na primeira sincronização, mesmo id e conteúdo), e cópias `"rabisco/clipboard"` na área de transferência. Não tire esse suporte sem um motivo: há quadros salvos com os nomes antigos.
- Elemento apagado não sai do arquivo (`deleted: true`), para o merge saber que foi apagado.
- Merge por elemento: `version` maior vence, empate decide pelo `nonce` maior.
- Rust sem `unwrap`/`expect` fora dos testes. TypeScript em modo estrito, com `noUncheckedIndexedAccess`.
- Ícones: SVG de traço fino com `currentColor`, em `web/src/components/Icon.svelte`. Sem emojis na interface.

## Comandos
Rust fica em `~/.cargo/bin` (`export PATH="$HOME/.cargo/bin:$PATH"` se faltar).
- `cargo test` e `cargo clippy --workspace --all-targets` na raiz.
- `cargo fmt --all`.
- Em `web/`:
  - `npm test`: gera o WASM (modo dev) e roda o Vitest. Os testes carregam o `.wasm` real.
  - `npm run check`: svelte-check, precisa terminar com 0 erros.
  - `npm run dev`: gera o WASM e abre em http://localhost:5173.
  - `npm run build`: gera o WASM em release e o site em `web/dist/`.
- O WASM gerado vai para `web/src/lib/core/pkg/`, fora do git. Ele sai de `scripts/build-wasm.sh`.

## Arquitetura da web
```
web/src/lib/core/   loadCore, newBoard, boardFromJson: único lugar que importa o WASM
web/src/lib/editor  ferramentas (seleção, mão, retângulo, seta, boneco, lápis, texto, borracha), ponteiros, rodinha e pinça
                    -> mudanças no Board ou na câmera (sem DOM, testado)
web/src/lib/text    fonte manuscrita (Kalam, empacotada) e medida de texto
web/src/lib/selection moldura de seleção e alças de redimensionar (editor e renderer usam a mesma conta)
web/src/lib/camera  câmera do canvas infinito (tela <-> mundo, zoom em torno de um ponto)
web/src/lib/path    decodifica o caminho achatado que vem do Rust
web/src/lib/renderer desenha no Canvas 2D, com cache de Path2D por versão do elemento
web/src/lib/storage IndexedDB + salvamento automático com atraso + cópia de emergência síncrona ao fechar a aba
web/src/lib/images  imagens: leitura (upload, colar, arrastar), redução das grandes, chave pelo conteúdo
web/src/lib/drive/  Google Drive: api (REST v3), auth (login por redirecionamento), sync (motor), controller (quando sincronizar)
web/src/lib/mermaid  Mermaid -> SVG pronto para virar imagem, modelos dos 5 tipos de diagrama
web/src/components/DiagramDialog  janela de diagrama: código Mermaid com prévia ao vivo
web/src/App.svelte  liga tudo: canvas, barra de ferramentas, zoom, status
```
