import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  server: {
    // O núcleo em WASM fica fora de src/ do ponto de vista do Rust: deixa o Vite ler a raiz do repositório.
    fs: { allow: ['..'] },
  },
  build: {
    // Os pedaços grandes são do Mermaid (layout ELK, KaTeX...), baixados só quando a janela
    // de diagrama abre; o pacote principal continua pequeno.
    chunkSizeWarningLimit: 1600,
  },
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
  },
});
