// Ponto único de acesso ao núcleo em Rust (WASM). O resto do site importa daqui,
// nunca direto de ./pkg, que é gerado por scripts/build-wasm.sh.
import init, { Board, isClipboard, schemaVersion } from './pkg/draw4fun_core.js';

export { Board, isClipboard, schemaVersion };

let ready: Promise<void> | null = null;

/** Carrega o `.wasm` uma vez só. Chame antes de criar um `Board`. */
export function loadCore(): Promise<void> {
  ready ??= init().then(() => undefined);
  return ready;
}

/** Semente aleatória de verdade, em duas metades de 32 bits, para os ids não colidirem entre aparelhos. */
export function randomSeed(): [number, number] {
  const parts = new Uint32Array(2);
  crypto.getRandomValues(parts);
  return [parts[0] ?? 0, parts[1] ?? 0];
}

export function newBoard(): Board {
  return new Board(...randomSeed());
}

export function boardFromJson(json: string): Board {
  return Board.fromJson(json, ...randomSeed());
}
