import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Autosaver,
  type DrawingStore,
  EmergencyBackup,
  IndexedDbStore,
  LEGACY_LOCAL_KEYS,
  type SaveStatus,
  migrateLegacyKeys,
} from './storage';

describe('IndexedDbStore', () => {
  it('começa vazio, salva e lê de volta', async () => {
    const store = new IndexedDbStore(new IDBFactory());
    expect(await store.load()).toBeNull();
    await store.save('{"a":1}');
    expect(await store.load()).toBe('{"a":1}');
  });

  it('salvar com outra chave não mexe no desenho atual', async () => {
    const store = new IndexedDbStore(new IDBFactory());
    await store.save('atual');
    await store.save('copia', 'ilegivel-1');
    expect(await store.load()).toBe('atual');
  });
});

describe('migração do tempo do Rabisco', () => {
  /** Cria o banco antigo, com o mesmo formato, e põe valores nele. */
  async function legacyDb(factory: IDBFactory, entries: Record<string, string>) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open('rabisco', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('drawings');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction('drawings', 'readwrite');
      for (const [k, v] of Object.entries(entries)) tx.objectStore('drawings').put(v, k);
      tx.oncomplete = () => resolve();
    });
    db.close();
  }

  it('traz o desenho e as cópias do banco antigo e apaga o antigo', async () => {
    const factory = new IDBFactory();
    await legacyDb(factory, { current: '{"velho":1}', 'ilegivel-1': 'x' });
    const store = new IndexedDbStore(factory);
    expect(await store.load()).toBe('{"velho":1}');
    const names = (await factory.databases()).map((d) => d.name);
    expect(names).toContain('draw4fun');
    expect(names).not.toContain('rabisco');
  });

  it('banco novo com conteúdo não é trocado pelo antigo', async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbStore(factory);
    await first.save('novo');
    await legacyDb(factory, { current: 'velho' });
    expect(await new IndexedDbStore(factory).load()).toBe('novo');
  });

  it('chaves antigas passam para as novas sem sobrescrever as que já existem', () => {
    const data = new Map<string, string>([
      ['rabisco:nao-salvo', 'backup'],
      ['rabisco:drive-estado', 'estado-velho'],
      ['draw4fun:drive-estado', 'estado-novo'],
      ['rabisco:diagrama-rascunho', 'lixo'],
    ]);
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    migrateLegacyKeys(storage, LEGACY_LOCAL_KEYS);
    expect(Object.fromEntries(data)).toEqual({ 'draw4fun:nao-salvo': 'backup', 'draw4fun:drive-estado': 'estado-novo' });
  });
});

describe('Autosaver', () => {
  afterEach(() => vi.useRealTimers());

  function memoryStore(): DrawingStore & { saves: string[] } {
    const saves: string[] = [];
    return { saves, load: async () => saves.at(-1) ?? null, save: async (json) => void saves.push(json) };
  }

  it('junta várias mudanças seguidas num salvamento só', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    let n = 0;
    const statuses: SaveStatus[] = [];
    const saver = new Autosaver(store, () => `v${++n}`, (s) => statuses.push(s), 500);
    saver.schedule();
    saver.schedule();
    saver.schedule();
    expect(store.saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.saves).toEqual(['v1']);
    expect(statuses.at(0)).toBe('pending');
    expect(statuses.at(-1)).toBe('saved');
  });

  it('sabe quando há mudança pendente', async () => {
    vi.useFakeTimers();
    const saver = new Autosaver(memoryStore(), () => 'x', () => {}, 500);
    expect(saver.hasPending).toBe(false);
    saver.schedule();
    expect(saver.hasPending).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(saver.hasPending).toBe(false);
  });

  it('flush salva na hora e cancela o agendado', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const saver = new Autosaver(store, () => 'agora', () => {}, 500);
    saver.schedule();
    await saver.flush();
    expect(store.saves).toEqual(['agora']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.saves).toEqual(['agora']);
  });

  it('erro ao salvar vira status de erro, sem derrubar', async () => {
    const statuses: SaveStatus[] = [];
    const failing: DrawingStore = { load: async () => null, save: async () => Promise.reject(new Error('cheio')) };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const saver = new Autosaver(failing, () => 'x', (s) => statuses.push(s));
    await saver.flush();
    expect(statuses.at(-1)).toBe('error');
    spy.mockRestore();
  });
});

describe('EmergencyBackup', () => {
  function memory() {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
  }

  it('grava, lê e limpa', () => {
    const backup = new EmergencyBackup(memory());
    expect(backup.read()).toBeNull();
    expect(backup.write('{"a":1}')).toBe(true);
    expect(backup.read()).toBe('{"a":1}');
    backup.clear();
    expect(backup.read()).toBeNull();
  });

  it('armazenamento cheio não derruba: só avisa que não coube', () => {
    const full = { ...memory(), setItem: () => { throw new DOMException('cheio', 'QuotaExceededError'); } };
    expect(new EmergencyBackup(full).write('x')).toBe(false);
  });

  it('sem armazenamento nenhum, não faz nada', () => {
    const backup = new EmergencyBackup(null);
    expect(backup.write('x')).toBe(false);
    expect(backup.read()).toBeNull();
  });
});
