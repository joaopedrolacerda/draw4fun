# draw4fun

Quadro branco para desenhar à mão livre, com formas de traço de esboço e canvas infinito.
O núcleo é em Rust: roda no navegador como WASM e depois no app Swift.

```bash
cd web && npm install && npm run dev
```

Veja `CLAUDE.md` para a estrutura, as regras e os comandos.

## Diagramas (Mermaid)
O botão de diagrama na barra abre um menu: escrever em [Mermaid](https://mermaid.js.org/intro/syntax-reference.html)
do zero ou partir de um modelo (fluxograma, sequência, classes, estados ou entidade-relacionamento).
A janela mostra a prévia enquanto você digita; "Inserir" (ou Ctrl+Enter) põe o diagrama no quadro.
Por padrão ele entra como **elementos editáveis**: cada caixa, linha, seta e texto vira um desenho
do quadro, que dá para mover, apagar, redimensionar e editar (clique duplo no texto). Tudo entra
selecionado, para mover junto, e num passo só do desfazer. A opção "Imagem" põe o diagrama como uma
imagem só, igual à prévia. Na conversão, linhas tracejadas viram contínuas e os símbolos de ponta
que não são seta (losango das classes, "pé de galinha" do ER) viram linha simples.

## Deploy (Railway)
O `Dockerfile` da raiz gera a imagem de produção em três etapas: compila o núcleo para WASM
(Rust + wasm-pack), gera o site com o Vite e serve os arquivos estáticos com o Caddy na
porta `$PORT` que o Railway informa. O Railway acha o `Dockerfile` sozinho.

1. No Railway, crie um serviço a partir do repositório do GitHub (ou use `railway up` nesta pasta).
2. Nas variáveis do serviço, crie `VITE_GOOGLE_CLIENT_ID` com o ID do cliente OAuth. Ela entra
   no build (o Vite grava no site); depois de mudar, faça um novo deploy.
3. Em **Settings → Networking**, gere um domínio público.
4. No Google Cloud, no cliente OAuth, acrescente o domínio em **Origens JavaScript autorizadas**
   (`https://seu-dominio`) e em **URIs de redirecionamento autorizados** (`https://seu-dominio/`,
   com a barra no fim). Sem isso o login com Google é recusado.

Para testar a imagem localmente:

```bash
docker build --build-arg VITE_GOOGLE_CLIENT_ID=seu-id -t draw4fun .
docker run --rm -p 8080:8080 draw4fun
```

## Google Drive

O quadro pode ser sincronizado no Google Drive de quem usa. O login é feito direto no navegador,
por redirecionamento (OAuth 2.0, fluxo de token), sem servidor e sem pop-up, com o escopo `drive.file`: o app só enxerga os arquivos
que ele mesmo criou. Os quadros ficam numa pasta **draw4fun** no Drive, um arquivo `.draw4fun` (JSON)
por quadro.

Sem configurar o ID do cliente, o botão do Drive não aparece e o quadro fica só no navegador.

### Criar o cliente OAuth (uma vez)

1. Em https://console.cloud.google.com, crie um projeto (por exemplo, "draw4fun").
2. **APIs e serviços → Biblioteca**: ative a **Google Drive API**.
3. **Google Auth Platform** (tela de consentimento):
   - **Branding**: nome do app "draw4fun" e o seu e-mail de suporte.
   - **Público**: "Externo". Enquanto o app estiver em "Teste", adicione o seu Gmail em **Usuários de teste**.
   - **Acesso a dados**: adicione o escopo `https://www.googleapis.com/auth/drive.file`.
     Ele não é sensível, então não precisa de verificação do Google para publicar.
4. **Clientes → Criar cliente → Aplicativo da Web**:
   - **Origens JavaScript autorizadas**: `http://localhost:5173` (e o endereço do site publicado, quando houver).
   - **URIs de redirecionamento autorizados**: `http://localhost:5173/`, **com a barra no fim**
     (e o endereço do site publicado com a barra, quando houver). O Google volta para a raiz do site.
5. Copie o **ID do cliente** (termina em `.apps.googleusercontent.com`) para `web/.env.local`:
   ```bash
   cp web/.env.example web/.env.local
   ```
   e preencha `VITE_GOOGLE_CLIENT_ID=`.
6. Reinicie o `npm run dev`. O botão **Entrar com Google** aparece no canto superior direito.

### Como a sincronização funciona

- A cópia de trabalho é sempre a do navegador; o Drive é onde os aparelhos se encontram.
- Envia uns segundos depois de cada mudança, confere o Drive a cada 30 s e quando a aba volta ao foco.
- Se os dois lados mudaram, junta elemento por elemento pelo merge do núcleo (nada se perde;
  quando o mesmo elemento mudou nos dois, vale a mudança mais recente).
- "Entrar" leva a página para o Google e volta; o desenho é gravado antes de sair.
- O acesso dura cerca de 1 hora e fica na aba (sobrevive a recarregar, some ao fechar a aba).
  Depois disso aparece **Reconectar ao Drive**: um clique, que volta direto se você já tinha permitido.
  As mudanças ficam guardadas no navegador até lá.
