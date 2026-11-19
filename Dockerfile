# syntax=docker/dockerfile:1
#
# Imagem de produção do draw4fun (usada pelo Railway).
#   1. wasm: compila o núcleo em Rust para WebAssembly.
#   2. web:  gera o site com o Vite.
#   3. final: só os arquivos estáticos, servidos pelo Caddy na porta $PORT.

# --- 1. Núcleo em WASM -------------------------------------------------------
FROM rust:1.99-slim AS wasm
# Versões fixas: o wasm-bindgen-cli precisa ser igual ao do Cargo.lock.
ARG WASM_PACK_VERSION=0.15.1
ARG WASM_BINDGEN_VERSION=0.2.130
RUN rustup target add wasm32-unknown-unknown \
 && cargo install --locked wasm-pack --version "${WASM_PACK_VERSION}" \
 && cargo install --locked wasm-bindgen-cli --version "${WASM_BINDGEN_VERSION}"
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY core core
COPY core-wasm core-wasm
COPY scripts scripts
RUN mkdir -p web/src/lib/core && bash scripts/build-wasm.sh

# --- 2. Site -------------------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
COPY fixtures /app/fixtures
COPY --from=wasm /app/web/src/lib/core/pkg ./src/lib/core/pkg
# ID do cliente OAuth do Google (não é segredo). No Railway, crie a variável de mesmo nome
# no serviço: ela chega aqui como argumento de build. Sem ela, o site sai sem o Drive.
ARG VITE_GOOGLE_CLIENT_ID=""
ENV VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}
# Chama o Vite direto: o WASM já veio pronto do estágio anterior (o `npm run build`
# tentaria gerar de novo, e aqui não há Rust).
RUN npx vite build

# --- 3. Servidor estático --------------------------------------------------------
FROM caddy:2.8-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=web /app/web/dist /srv
# O Railway informa a porta em $PORT; fora dele, 8080.
ENV PORT=8080
EXPOSE 8080
