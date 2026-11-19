// Nos testes não há fetch do .wasm: lê o arquivo gerado e inicializa o núcleo de forma síncrona.
import { readFileSync } from 'node:fs';
import { initSync } from '../lib/core/pkg/draw4fun_core.js';

initSync({ module: readFileSync(new URL('../lib/core/pkg/draw4fun_core_bg.wasm', import.meta.url)) });
