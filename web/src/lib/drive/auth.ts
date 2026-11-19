// Login com Google por redirecionamento (OAuth 2.0 no navegador, fluxo de token), sem servidor.
//
// "Entrar" leva a página inteira para o Google; depois do login, o Google volta para o
// draw4fun com o token no fragmento da URL (`#access_token=...`). Não usa pop-up: a janela
// de login do Google atrapalha a comunicação entre janelas (Cross-Origin-Opener-Policy),
// e o login por pop-up ficava preso em "Conectando…".
//
// O token dura cerca de 1 hora e fica no `sessionStorage` da aba (sobrevive a recarregar,
// some ao fechar a aba). Escopo `drive.file`: só os arquivos que o próprio app criou.

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** Folga antes do vencimento: um token a 1 minuto de vencer já é tratado como vencido. */
const EXPIRY_MARGIN_MS = 60_000;
const TOKEN_KEY = 'draw4fun:google-token';
const STATE_KEY = 'draw4fun:google-state';

export class NeedsAuthError extends Error {
  constructor(message = 'É preciso entrar com Google de novo.') {
    super(message);
    this.name = 'NeedsAuthError';
  }
}

/** Resultado da volta do Google: deu certo, deu erro, ou a página não veio do Google. */
export type RedirectResult = { ok: true } | { ok: false; error: string } | null;

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface RedirectAuthEnv {
  /** URL atual da página (com o fragmento). */
  currentUrl(): string;
  /** Troca a URL sem recarregar (para limpar o token do fragmento). */
  replaceUrl(url: string): void;
  /** Leva a página para outro endereço (o Google). */
  navigate(url: string): void;
  storage: KeyValue | null;
  fetch: typeof fetch;
  now(): number;
  randomState(): string;
}

function browserEnv(): RedirectAuthEnv {
  return {
    currentUrl: () => location.href,
    replaceUrl: (url) => history.replaceState(history.state, '', url),
    navigate: (url) => location.assign(url),
    storage: safeSessionStorage(),
    fetch: (...args) => fetch(...args),
    now: Date.now,
    randomState: () => {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    },
  };
}

interface StoredToken {
  token: string;
  expiresAt: number;
}

export class RedirectAuth {
  private env: RedirectAuthEnv;

  constructor(
    private clientId: string,
    env: Partial<RedirectAuthEnv> = {},
  ) {
    this.env = { ...browserEnv(), ...env };
  }

  /** Endereço para onde o Google volta: a raiz do site (precisa estar autorizado no Google Cloud). */
  get redirectUri(): string {
    return `${new URL(this.env.currentUrl()).origin}/`;
  }

  get hasValidToken(): boolean {
    const t = this.stored();
    return t !== null && this.env.now() < t.expiresAt - EXPIRY_MARGIN_MS;
  }

  /**
   * Vai para o Google. `consent` deixa escolher a conta (primeiro login); `silent` volta
   * direto se a pessoa já tinha permitido. A página sai daqui: a promessa não resolve.
   */
  connect(mode: 'consent' | 'silent'): Promise<void> {
    const state = this.env.randomState();
    this.write(STATE_KEY, state);
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'token',
      scope: DRIVE_SCOPE,
      include_granted_scopes: 'true',
      state,
    });
    if (mode === 'consent') params.set('prompt', 'select_account');
    this.env.navigate(`${AUTH_URL}?${params.toString()}`);
    return new Promise(() => {});
  }

  /** No redirecionamento não há login "em andamento" na página para cancelar. */
  cancel(): void {}

  /**
   * Chame ao abrir a página: se ela voltou do Google, guarda o token (ou lê o erro)
   * e limpa o fragmento da URL, para o token não ficar no histórico nem ser copiado.
   */
  completeRedirect(): RedirectResult {
    const url = new URL(this.env.currentUrl());
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
    if (!fragment.has('access_token') && !fragment.has('error')) return null;

    url.hash = '';
    this.env.replaceUrl(url.toString());
    const expected = this.read(STATE_KEY);
    this.remove(STATE_KEY);

    if (!expected || fragment.get('state') !== expected) {
      return { ok: false, error: 'A resposta do Google não confere com o pedido. Tente entrar de novo.' };
    }
    const error = fragment.get('error');
    if (error) {
      return { ok: false, error: error === 'access_denied' ? 'O acesso ao Google foi negado.' : `O Google recusou o login (${error}).` };
    }
    const scopes = (fragment.get('scope') ?? '').split(' ');
    if (!scopes.includes(DRIVE_SCOPE)) {
      return { ok: false, error: 'Para sincronizar, marque a permissão do Google Drive na tela do Google.' };
    }
    const token = fragment.get('access_token') ?? '';
    const expiresIn = Number(fragment.get('expires_in') ?? '3600');
    this.write(TOKEN_KEY, JSON.stringify({ token, expiresAt: this.env.now() + expiresIn * 1000 } satisfies StoredToken));
    return { ok: true };
  }

  /** Token válido, ou `NeedsAuthError` se venceu (aí é preciso clicar em "Reconectar"). */
  async token(): Promise<string> {
    const t = this.stored();
    if (!t || !this.hasValidToken) throw new NeedsAuthError();
    return t.token;
  }

  /** O Drive recusou o token antes da hora (revogado, por exemplo): esquece ele. */
  invalidate(): void {
    this.remove(TOKEN_KEY);
  }

  /** Sai: revoga o acesso no Google e esquece o token. */
  async disconnect(): Promise<void> {
    const t = this.stored();
    this.invalidate();
    if (!t) return;
    try {
      await this.env.fetch(`${REVOKE_URL}?${new URLSearchParams({ token: t.token }).toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch {
      // Sem internet: o token vence sozinho em menos de uma hora.
    }
  }

  private stored(): StoredToken | null {
    const raw = this.read(TOKEN_KEY);
    if (!raw) return null;
    try {
      const t = JSON.parse(raw) as Partial<StoredToken>;
      return typeof t.token === 'string' && typeof t.expiresAt === 'number' ? { token: t.token, expiresAt: t.expiresAt } : null;
    } catch {
      return null;
    }
  }

  private read(key: string): string | null {
    try {
      return this.env.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    try {
      this.env.storage?.setItem(key, value);
    } catch {
      // Sem armazenamento: o login vale só até recarregar.
    }
  }

  private remove(key: string): void {
    try {
      this.env.storage?.removeItem(key);
    } catch {
      // Nada a limpar.
    }
  }
}

function safeSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
