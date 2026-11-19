import { describe, expect, it, vi } from 'vitest';
import { DriveApi, DriveAuthError, DriveError } from './api';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('resposta não prevista');
    return next;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const header = (c: Call | undefined, name: string) => (c?.init.headers as Record<string, string> | undefined)?.[name];

describe('DriveApi', () => {
  it('manda o token e acha a pasta pelo nome', async () => {
    const { fn, calls } = fakeFetch([json({ files: [{ id: 'pasta1', name: 'draw4fun' }] })]);
    const api = new DriveApi(async () => 'tok', fn);
    expect(await api.findFolder()).toBe('pasta1');
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('q')).toContain("name='draw4fun'");
    expect(url.searchParams.get('q')).toContain('trashed=false');
    expect(header(calls[0], 'Authorization')).toBe('Bearer tok');
  });

  it('só com a pasta do tempo do Rabisco, renomeia e usa ela', async () => {
    const { fn, calls } = fakeFetch([json({ files: [{ id: 'velha', name: 'Rabisco' }] }), json({ id: 'velha' })]);
    expect(await new DriveApi(async () => 't', fn).findFolder()).toBe('velha');
    expect(new URL(calls[0]?.url ?? '').searchParams.get('q')).toContain("name='Rabisco'");
    expect(calls[1]?.url).toContain('/drive/v3/files/velha?');
    expect(calls[1]?.init.method).toBe('PATCH');
    expect(calls[1]?.init.body).toBe('{"name":"draw4fun"}');
  });

  it('com as duas pastas, fica com a de nome novo sem renomear nada', async () => {
    const { fn, calls } = fakeFetch([json({ files: [{ id: 'velha', name: 'Rabisco' }, { id: 'nova', name: 'draw4fun' }] })]);
    expect(await new DriveApi(async () => 't', fn).findFolder()).toBe('nova');
    expect(calls).toHaveLength(1);
  });

  it('sem pasta devolve null', async () => {
    const { fn } = fakeFetch([json({ files: [] })]);
    expect(await new DriveApi(async () => 't', fn).findFolder()).toBeNull();
  });

  it('cria o quadro com metadados e conteúdo num envio só', async () => {
    const { fn, calls } = fakeFetch([json({ id: 'arq1', version: '3' })]);
    const api = new DriveApi(async () => 't', fn);
    expect(await api.create('pasta1', 'Meu quadro.draw4fun', '{"schemaVersion":1}')).toEqual({ id: 'arq1', version: '3' });
    const call = calls[0];
    expect(call?.url).toContain('/upload/drive/v3/files?uploadType=multipart');
    expect(call?.init.method).toBe('POST');
    const body = String(call?.init.body);
    expect(body).toContain('"parents":["pasta1"]');
    expect(body).toContain('"appProperties":{"draw4fun":"board"}');
    expect(body).toContain('{"schemaVersion":1}');
    expect(header(call, 'Content-Type')).toMatch(/^multipart\/related; boundary=/);
  });

  it('atualiza só o conteúdo', async () => {
    const { fn, calls } = fakeFetch([json({ id: 'arq1', version: '4' })]);
    await new DriveApi(async () => 't', fn).update('arq1', '{}');
    expect(calls[0]?.url).toContain('/upload/drive/v3/files/arq1?uploadType=media');
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(calls[0]?.init.body).toBe('{}');
  });

  it('baixa o conteúdo como texto', async () => {
    const { fn, calls } = fakeFetch([new Response('{"a":1}')]);
    expect(await new DriveApi(async () => 't', fn).download('arq1')).toBe('{"a":1}');
    expect(calls[0]?.url).toContain('/files/arq1?alt=media');
  });

  it('arquivo na lixeira ou apagado conta como inexistente', async () => {
    const { fn } = fakeFetch([json({ id: 'a', version: '1', trashed: true }), json({ error: { message: 'File not found' } }, 404)]);
    const api = new DriveApi(async () => 't', fn);
    expect(await api.getMeta('a')).toBeNull();
    expect(await api.getMeta('b')).toBeNull();
  });

  it('reconhece o quadro do tempo do Rabisco e migra arquivo e pasta', async () => {
    const { fn, calls } = fakeFetch([
      json({ id: 'a', version: '5', trashed: false, appProperties: { rabisco: 'board' }, parents: ['p1'] }),
      json({ id: 'a' }),
      json({ name: 'Rabisco' }),
      json({ id: 'p1' }),
      json({ id: 'b', version: '2', trashed: false, appProperties: { draw4fun: 'board' }, parents: ['p1'] }),
    ]);
    const api = new DriveApi(async () => 't', fn);
    expect(await api.getMeta('a')).toEqual({ id: 'a', version: '5', legacy: true, parents: ['p1'] });
    await api.migrateLegacy('a', 'Meu quadro.draw4fun', ['p1']);
    expect(calls[1]?.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      name: 'Meu quadro.draw4fun',
      appProperties: { draw4fun: 'board', rabisco: null },
    });
    expect(calls[3]?.url).toContain('/files/p1?');
    expect(calls[3]?.init.body).toBe('{"name":"draw4fun"}');
    expect(await api.getMeta('b')).toMatchObject({ legacy: false });
  });

  it('401 vira erro de autenticação; outros erros levam a mensagem do Drive', async () => {
    const { fn } = fakeFetch([json({ error: { message: 'Invalid Credentials' } }, 401), json({ error: { message: 'Rate limit' } }, 403)]);
    const api = new DriveApi(async () => 't', fn);
    await expect(api.findFolder()).rejects.toBeInstanceOf(DriveAuthError);
    const err = await api.findFolder().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriveError);
    expect((err as DriveError).status).toBe(403);
    expect((err as DriveError).message).toBe('Rate limit');
  });

  it('lista os quadros da pasta pela marca, do mais recente para o mais antigo', async () => {
    const { fn, calls } = fakeFetch([json({ files: [{ id: 'q1', name: 'a', version: '1', modifiedTime: 't' }] })]);
    const boards = await new DriveApi(async () => 't', fn).findBoards('pasta1');
    expect(boards.map((b) => b.id)).toEqual(['q1']);
    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('q')).toContain("'pasta1' in parents");
    expect(url.searchParams.get('q')).toContain("key='draw4fun' and value='board'");
    expect(url.searchParams.get('q')).toContain("key='rabisco' and value='board'");
    expect(url.searchParams.get('orderBy')).toBe('modifiedTime desc');
  });
});
