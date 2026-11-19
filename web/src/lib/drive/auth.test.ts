import { describe, expect, it, vi } from 'vitest';
import { DRIVE_SCOPE, NeedsAuthError, RedirectAuth, type RedirectAuthEnv } from './auth';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

/** Navegador falso: URL atual, armazenamento da aba e relógio controláveis. */
function env(start = 'http://localhost:5173/') {
  let url = start;
  let now = 1_000_000;
  const storage = memoryStorage();
  const navigations: string[] = [];
  const fetchFn = vi.fn(async () => new Response(''));
  const e: Partial<RedirectAuthEnv> = {
    currentUrl: () => url,
    replaceUrl: (u) => (url = u),
    navigate: (u) => navigations.push(u),
    storage,
    fetch: fetchFn as unknown as typeof fetch,
    now: () => now,
    randomState: () => 'estado123',
  };
  return {
    env: e,
    storage,
    navigations,
    fetchFn,
    setUrl: (u: string) => (url = u),
    url: () => url,
    advance: (ms: number) => (now += ms),
  };
}

const back = (fragment: Record<string, string>) =>
  `http://localhost:5173/#${new URLSearchParams(fragment).toString()}`;

describe('RedirectAuth', () => {
  it('entrar leva ao Google com o cliente, a volta para a raiz do site e o escopo do Drive', () => {
    const t = env();
    const auth = new RedirectAuth('cliente-1', t.env);
    void auth.connect('consent');
    const go = new URL(t.navigations[0] ?? '');
    expect(go.origin + go.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(go.searchParams.get('client_id')).toBe('cliente-1');
    expect(go.searchParams.get('redirect_uri')).toBe('http://localhost:5173/');
    expect(go.searchParams.get('response_type')).toBe('token');
    expect(go.searchParams.get('scope')).toBe(DRIVE_SCOPE);
    expect(go.searchParams.get('state')).toBe('estado123');
    expect(go.searchParams.get('prompt')).toBe('select_account');
  });

  it('reconectar não pede para escolher conta', () => {
    const t = env();
    void new RedirectAuth('c', t.env).connect('silent');
    expect(new URL(t.navigations[0] ?? '').searchParams.has('prompt')).toBe(false);
  });

  it('a volta do Google guarda o token, limpa a URL e o token vale até perto de vencer', async () => {
    const t = env();
    const auth = new RedirectAuth('c', t.env);
    void auth.connect('consent');
    t.setUrl(back({ access_token: 'tok', expires_in: '3599', state: 'estado123', scope: DRIVE_SCOPE }));
    expect(auth.completeRedirect()).toEqual({ ok: true });
    expect(t.url()).toBe('http://localhost:5173/');
    expect(await auth.token()).toBe('tok');
    t.advance(3599_000 - 30_000);
    await expect(auth.token()).rejects.toBeInstanceOf(NeedsAuthError);
  });

  it('token sobrevive a recarregar a página (mesma aba)', async () => {
    const t = env();
    const first = new RedirectAuth('c', t.env);
    void first.connect('consent');
    t.setUrl(back({ access_token: 'tok', expires_in: '3600', state: 'estado123', scope: DRIVE_SCOPE }));
    first.completeRedirect();
    const reloaded = new RedirectAuth('c', t.env);
    expect(reloaded.completeRedirect()).toBeNull();
    expect(await reloaded.token()).toBe('tok');
  });

  it('página aberta normalmente não é volta do Google', () => {
    const t = env('http://localhost:5173/');
    expect(new RedirectAuth('c', t.env).completeRedirect()).toBeNull();
  });

  it('recusa resposta com estado diferente do pedido', () => {
    const t = env();
    const auth = new RedirectAuth('c', t.env);
    void auth.connect('consent');
    t.setUrl(back({ access_token: 'tok', state: 'outro', scope: DRIVE_SCOPE }));
    expect(auth.completeRedirect()).toEqual({ ok: false, error: expect.stringMatching(/não confere/) });
    expect(auth.hasValidToken).toBe(false);
  });

  it('acesso negado e permissão do Drive desmarcada viram mensagens claras', () => {
    const denied = env();
    const a = new RedirectAuth('c', denied.env);
    void a.connect('consent');
    denied.setUrl(back({ error: 'access_denied', state: 'estado123' }));
    expect(a.completeRedirect()).toEqual({ ok: false, error: 'O acesso ao Google foi negado.' });

    const noDrive = env();
    const b = new RedirectAuth('c', noDrive.env);
    void b.connect('consent');
    noDrive.setUrl(back({ access_token: 'tok', state: 'estado123', scope: 'openid' }));
    expect(b.completeRedirect()).toEqual({ ok: false, error: expect.stringMatching(/permissão do Google Drive/) });
    expect(b.hasValidToken).toBe(false);
  });

  it('sair revoga no Google e esquece o token', async () => {
    const t = env();
    const auth = new RedirectAuth('c', t.env);
    void auth.connect('consent');
    t.setUrl(back({ access_token: 'tok', expires_in: '3600', state: 'estado123', scope: DRIVE_SCOPE }));
    auth.completeRedirect();
    await auth.disconnect();
    expect(t.fetchFn).toHaveBeenCalledWith('https://oauth2.googleapis.com/revoke?token=tok', expect.objectContaining({ method: 'POST' }));
    await expect(auth.token()).rejects.toBeInstanceOf(NeedsAuthError);
  });

  it('token recusado pelo Drive é esquecido', () => {
    const t = env();
    const auth = new RedirectAuth('c', t.env);
    void auth.connect('consent');
    t.setUrl(back({ access_token: 'tok', expires_in: '3600', state: 'estado123', scope: DRIVE_SCOPE }));
    auth.completeRedirect();
    auth.invalidate();
    expect(auth.hasValidToken).toBe(false);
  });
});
