import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Board, newBoard } from '../core';
import { DriveAuthError, type DriveLike, type RemoteBoard, type RemoteFile } from './api';
import { NeedsAuthError } from './auth';
import { SyncEngine, type SyncState, type SyncStatus } from './sync';

/** Drive em memória, compartilhado pelos "aparelhos" do teste. */
class FakeDrive implements DriveLike {
  folders: string[] = [];
  files = new Map<string, { content: string; version: number; parent: string; trashed: boolean; modified: number; legacy?: boolean }>();
  migrated: string[] = [];
  calls: string[] = [];
  failNext: Error | null = null;
  private seq = 0;
  private clock = 0;

  private check(call: string) {
    this.calls.push(call);
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }

  async findFolder() {
    this.check('findFolder');
    return this.folders[0] ?? null;
  }
  async createFolder() {
    this.check('createFolder');
    const id = `pasta${++this.seq}`;
    this.folders.push(id);
    return id;
  }
  async findBoards(folderId: string): Promise<RemoteBoard[]> {
    this.check('findBoards');
    return [...this.files.entries()]
      .filter(([, f]) => f.parent === folderId && !f.trashed)
      .sort((a, b) => b[1].modified - a[1].modified)
      .map(([id, f]) => ({ id, name: 'q', version: String(f.version), modifiedTime: String(f.modified) }));
  }
  async getMeta(fileId: string): Promise<RemoteFile | null> {
    this.check('getMeta');
    const f = this.files.get(fileId);
    return f && !f.trashed ? { id: fileId, version: String(f.version), legacy: f.legacy ?? false, parents: [f.parent] } : null;
  }
  async download(fileId: string) {
    this.check('download');
    return this.files.get(fileId)?.content ?? '';
  }
  async create(folderId: string, _name: string, json: string): Promise<RemoteFile> {
    this.check('create');
    const id = `arq${++this.seq}`;
    this.files.set(id, { content: json, version: 1, parent: folderId, trashed: false, modified: ++this.clock });
    return { id, version: '1' };
  }
  async migrateLegacy(fileId: string, name: string, parents: string[]): Promise<void> {
    this.check('migrateLegacy');
    const f = this.files.get(fileId);
    if (f) f.legacy = false;
    this.migrated.push(`${fileId}:${name}:${parents.join(',')}`);
  }
  async update(fileId: string, json: string): Promise<RemoteFile> {
    this.check('update');
    const f = this.files.get(fileId);
    if (!f) throw new Error('não existe');
    f.content = json;
    f.version += 1;
    f.modified = ++this.clock;
    return { id: fileId, version: String(f.version) };
  }
}

/** Um aparelho: quadro local, estado salvo e motor de sincronização. */
function device(drive: FakeDrive, saved: SyncState | null = null) {
  const board = newBoard();
  let state = saved;
  const statuses: { status: SyncStatus; detail?: string }[] = [];
  const merged = vi.fn();
  const engine = new SyncEngine({
    drive,
    getJson: () => board.toJson(),
    mergeRemote: (json) => {
      board.mergeRemote(json);
      merged();
    },
    loadState: () => state,
    saveState: (s) => (state = s),
    onStatus: (status, detail) => statuses.push({ status, detail }),
  });
  return {
    board,
    engine,
    statuses,
    merged,
    state: () => state,
    draw(x: number) {
      const id = board.addRectangle(x, 0, 10, 10, '#000', 2, 1);
      engine.markDirty();
      return id;
    },
    last: () => statuses.at(-1),
  };
}

const boards: Board[] = [];
afterEach(() => {
  for (const b of boards.splice(0)) b.free();
});
function track<T extends { board: Board }>(d: T): T {
  boards.push(d.board);
  return d;
}

describe('SyncEngine', () => {
  it('primeira vez: cria a pasta e o arquivo com o quadro local', async () => {
    const drive = new FakeDrive();
    const a = track(device(drive));
    a.draw(0);
    await a.engine.sync();
    expect(drive.folders).toHaveLength(1);
    expect(drive.files.size).toBe(1);
    expect(a.last()?.status).toBe('synced');
    expect(a.state()).toMatchObject({ fileId: 'arq2', remoteVersion: '1', dirty: false });
  });

  it('sem mudança, a rodada só confere a versão e não envia nada', async () => {
    const drive = new FakeDrive();
    const a = track(device(drive));
    await a.engine.sync();
    drive.calls = [];
    await a.engine.sync();
    expect(drive.calls).toEqual(['getMeta']);
  });

  it('mudança local é enviada na rodada seguinte', async () => {
    const drive = new FakeDrive();
    const a = track(device(drive));
    await a.engine.sync();
    a.draw(0);
    await a.engine.sync();
    const content = [...drive.files.values()][0]?.content ?? '';
    expect(JSON.parse(content).elements).toHaveLength(1);
  });

  it('dois aparelhos: o segundo adota o quadro que já existe e os dois convergem', async () => {
    const drive = new FakeDrive();
    const phone = track(device(drive));
    const laptop = track(device(drive));
    const r1 = phone.draw(0);
    await phone.engine.sync();

    const r2 = laptop.draw(100);
    await laptop.engine.sync(); // acha o arquivo do celular, junta e envia
    expect(drive.files.size).toBe(1);
    expect(new Set(laptop.board.visibleIds())).toEqual(new Set([r1, r2]));

    await phone.engine.sync(); // vê versão nova, baixa e junta
    expect(new Set(phone.board.visibleIds())).toEqual(new Set([r1, r2]));
    expect(phone.merged).toHaveBeenCalled();
  });

  it('edições nos dois lados ao mesmo tempo não se perdem', async () => {
    const drive = new FakeDrive();
    const a = track(device(drive));
    const b = track(device(drive));
    await a.engine.sync();
    await b.engine.sync();

    const fromA = a.draw(0);
    const fromB = b.draw(50);
    await a.engine.sync();
    await b.engine.sync(); // b junta o de a e envia os dois
    await a.engine.sync(); // a recebe o de b

    for (const d of [a, b]) expect(new Set(d.board.visibleIds())).toEqual(new Set([fromA, fromB]));
  });

  it('apagar em um aparelho apaga no outro', async () => {
    const drive = new FakeDrive();
    const a = track(device(drive));
    const b = track(device(drive));
    const r = a.draw(0);
    await a.engine.sync();
    await b.engine.sync();
    b.board.remove(r);
    b.engine.markDirty();
    await b.engine.sync();
    await a.engine.sync();
    expect(a.board.visibleIds()).toEqual([]);
  });

  it('arquivo apagado no Drive é recriado com o quadro local', async () => {
    const drive = new FakeDrive();
    const a = track(device(drive));
    a.draw(0);
    await a.engine.sync();
    const first = a.state()?.fileId ?? '';
    const f = drive.files.get(first);
    if (f) f.trashed = true;
    await a.engine.sync();
    expect(a.state()?.fileId).not.toBe(first);
    expect([...drive.files.values()].filter((x) => !x.trashed)).toHaveLength(1);
  });

  it('token vencido pede para reconectar e guarda a mudança para depois', async () => {
    const drive = new FakeDrive();
    const a = track(device(drive));
    await a.engine.sync();
    a.draw(0);
    drive.failNext = new NeedsAuthError();
    await a.engine.sync();
    expect(a.last()?.status).toBe('needs-auth');
    expect(a.engine.hasPendingChanges).toBe(true);
    await a.engine.sync();
    expect(a.last()?.status).toBe('synced');
    expect(a.engine.hasPendingChanges).toBe(false);
  });

  it('Drive recusando o token também pede para reconectar', async () => {
    const drive = new FakeDrive();
    const a = track(device(drive));
    drive.failNext = new DriveAuthError();
    await a.engine.sync();
    expect(a.last()?.status).toBe('needs-auth');
  });

  it('falha no envio mantém a mudança pendente', async () => {
    const drive = new FakeDrive();
    const a = track(device(drive));
    await a.engine.sync();
    a.draw(0);
    const update = drive.update.bind(drive);
    drive.update = async () => {
      throw new TypeError('Failed to fetch');
    };
    await a.engine.sync();
    expect(a.last()?.status).toBe('offline');
    expect(a.engine.hasPendingChanges).toBe(true);
    drive.update = update;
    await a.engine.sync();
    expect(a.engine.hasPendingChanges).toBe(false);
  });

  it('arquivo ilegível no Drive não é sobrescrito', async () => {
    const drive = new FakeDrive();
    const a = track(device(drive));
    await a.engine.sync();
    const id = a.state()?.fileId ?? '';
    const f = drive.files.get(id);
    if (f) {
      f.content = '{"schemaVersion":99,"elements":[]}';
      f.version += 1;
    }
    a.draw(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await a.engine.sync();
    expect(a.last()).toEqual({ status: 'error', detail: expect.stringMatching(/não pôde ser lido/) });
    expect(drive.files.get(id)?.content).toBe('{"schemaVersion":99,"elements":[]}');
    vi.restoreAllMocks();
  });

  it('mudança feita durante o envio entra numa rodada a mais', async () => {
    const drive = new FakeDrive();
    const a = track(device(drive));
    await a.engine.sync();
    const update = drive.update.bind(drive);
    let duringUpload = true;
    drive.update = async (id, json) => {
      const sent = await update(id, json);
      if (duringUpload) {
        duringUpload = false;
        a.draw(20); // desenhou enquanto o primeiro envio estava no ar
        void a.engine.sync(); // vários pedidos no meio viram uma rodada só
        void a.engine.sync();
      }
      return sent;
    };
    drive.calls = [];
    a.draw(0);
    await a.engine.sync();
    expect(drive.calls.filter((c) => c === 'update')).toHaveLength(2);
    const content = [...drive.files.values()][0]?.content ?? '';
    expect(JSON.parse(content).elements).toHaveLength(2);
    expect(a.engine.hasPendingChanges).toBe(false);
  });

  it('quadro do tempo do Rabisco é renomeado e continua sendo o mesmo arquivo', async () => {
    const drive = new FakeDrive();
    const old = track(device(drive));
    old.draw(0);
    await old.engine.sync();
    const [fileId] = [...drive.files.keys()];
    const file = drive.files.get(fileId ?? '');
    if (file) file.legacy = true;

    const b = track(device(drive));
    await b.engine.sync();
    expect(drive.migrated).toEqual([`${fileId}:Meu quadro.draw4fun:pasta1`]);
    expect(drive.files.size).toBe(1);
    expect(b.board.visibleIds()).toHaveLength(1);
    expect(b.last()?.status).toBe('synced');

    // Já migrado: não renomeia de novo.
    await b.engine.sync();
    expect(drive.migrated).toHaveLength(1);
  });

  it('falha ao renomear o quadro antigo não impede a sincronização', async () => {
    const drive = new FakeDrive();
    const old = track(device(drive));
    old.draw(0);
    await old.engine.sync();
    const file = [...drive.files.values()][0];
    if (file) file.legacy = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    drive.migrateLegacy = async () => {
      throw new Error('sem permissão');
    };
    const b = track(device(drive));
    await b.engine.sync();
    expect(b.board.visibleIds()).toHaveLength(1);
    expect(b.last()?.status).toBe('synced');
    warn.mockRestore();
  });

  it('estado salvo continua de onde parou depois de recarregar', async () => {
    const drive = new FakeDrive();
    const a = track(device(drive));
    a.draw(0);
    await a.engine.sync();
    const again = track(device(drive, a.state()));
    drive.calls = [];
    await again.engine.sync();
    // Mesmo arquivo, mesma versão e nada pendente: só confere, sem baixar nem enviar.
    expect(drive.calls).toEqual(['getMeta']);
  });
});
