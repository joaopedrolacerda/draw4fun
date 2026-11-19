import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveLike, RemoteFile } from './api';
import { type AuthLike, DriveController, type DriveUiState } from './controller';
import type { SyncState } from './sync';

class FakeAuth implements AuthLike {
  hasValidToken = false;
  fail: Error | null = null;
  connect = vi.fn(async () => {
    if (this.fail) throw this.fail;
    this.hasValidToken = true;
  });
  invalidate = vi.fn(() => {
    this.hasValidToken = false;
  });
  disconnect = vi.fn(async () => {
    this.hasValidToken = false;
  });
}

/** Drive mínimo: um arquivo, conta quantas vezes enviou. */
function fakeDrive() {
  let content = '';
  let version = 0;
  const uploads: string[] = [];
  const drive: DriveLike = {
    findFolder: async () => 'pasta',
    createFolder: async () => 'pasta',
    findBoards: async () => [],
    getMeta: async (): Promise<RemoteFile | null> => (version ? { id: 'arq', version: String(version) } : null),
    download: async () => content,
    create: async (_f, _n, json) => {
      content = json;
      uploads.push(json);
      return { id: 'arq', version: String(++version) };
    },
    update: async (_id, json) => {
      content = json;
      uploads.push(json);
      return { id: 'arq', version: String(++version) };
    },
    migrateLegacy: async () => {},
  };
  return { drive, uploads };
}

describe('DriveController', () => {
  let auth: FakeAuth;
  let flag: boolean;
  let states: { state: DriveUiState; detail?: string }[];
  let saved: SyncState | null;
  let json: string;
  let fake: ReturnType<typeof fakeDrive>;

  function controller() {
    return new DriveController(
      {
        auth,
        drive: fake.drive,
        getJson: () => json,
        mergeRemote: () => {},
        stateStore: { load: () => saved, save: (s) => (saved = s) },
        connectedFlag: { get: () => flag, set: (v) => (flag = v) },
        onState: (state, detail) => states.push({ state, detail }),
      },
      { debounceMs: 2000, pollMs: 30_000 },
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    auth = new FakeAuth();
    flag = false;
    states = [];
    saved = null;
    json = '{"schemaVersion":1,"elements":[]}';
    fake = fakeDrive();
  });
  afterEach(() => vi.useRealTimers());

  it('começa desconectado, ou pedindo para reconectar se já entrou antes', async () => {
    await controller().start();
    flag = true;
    await controller().start();
    expect(states.map((s) => s.state)).toEqual(['off', 'needs-auth']);
  });

  it('entrar lembra a conexão e já envia o quadro', async () => {
    const c = controller();
    await c.connect('consent');
    expect(auth.connect).toHaveBeenCalledWith('consent');
    expect(flag).toBe(true);
    expect(fake.uploads).toHaveLength(1);
    expect(states.at(-1)?.state).toBe('synced');
    expect(c.folderUrl).toBe('https://drive.google.com/drive/folders/pasta');
    c.dispose();
  });

  it('login recusado volta ao estado anterior com a mensagem', async () => {
    auth.fail = new Error('A janela do Google foi fechada antes de terminar.');
    await controller().connect('consent');
    expect(states.at(-1)).toEqual({ state: 'off', detail: 'A janela do Google foi fechada antes de terminar.' });
    expect(flag).toBe(false);
  });

  it('ao abrir com login válido (voltando do Google), já sincroniza', async () => {
    auth.hasValidToken = true;
    const c = controller();
    await c.start();
    expect(flag).toBe(true);
    expect(fake.uploads).toHaveLength(1);
    expect(states.at(-1)?.state).toBe('synced');
    c.dispose();
  });

  it('mudanças seguidas viram um envio só, alguns segundos depois', async () => {
    const c = controller();
    await c.connect('consent');
    json = '{"schemaVersion":1,"elements":[],"x":1}';
    c.localChange();
    c.localChange();
    c.localChange();
    expect(fake.uploads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.uploads).toHaveLength(2);
    c.dispose();
  });

  it('confere o Drive de tempos em tempos', async () => {
    const c = controller();
    await c.connect('consent');
    const getMeta = vi.spyOn(fake.drive, 'getMeta');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getMeta).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it('sem login, mudança fica guardada e sincronizar pede reconexão', async () => {
    flag = true;
    const c = controller();
    c.localChange();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.uploads).toHaveLength(0);
    await c.syncNow();
    expect(states.at(-1)?.state).toBe('needs-auth');
    await c.connect('silent');
    expect(fake.uploads).toHaveLength(1);
    c.dispose();
  });

  it('sair revoga, esquece o arquivo e para de sincronizar', async () => {
    const c = controller();
    await c.connect('consent');
    await c.disconnect();
    expect(auth.disconnect).toHaveBeenCalled();
    expect(flag).toBe(false);
    expect(saved?.fileId).toBeNull();
    expect(states.at(-1)?.state).toBe('off');
    const getMeta = vi.spyOn(fake.drive, 'getMeta');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getMeta).not.toHaveBeenCalled();
  });
});
