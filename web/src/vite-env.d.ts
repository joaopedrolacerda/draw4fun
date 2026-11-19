/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** ID do cliente OAuth do Google (tipo Web). Sem ele, o botão do Drive não aparece. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
