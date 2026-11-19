#!/usr/bin/env bash
# Compila o núcleo para WASM e põe o pacote em web/src/lib/core/pkg (fora do git).
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
profile="${1:---release}"
wasm-pack build "$root/core-wasm" "$profile" \
  --target web \
  --out-dir "$root/web/src/lib/core/pkg" \
  --out-name draw4fun_core \
  --no-pack
