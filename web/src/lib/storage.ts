// Salvamento local do desenho aberto. Funciona sem login; o Drive entra numa etapa depois,
// por cima disto (o arquivo local continua sendo a cópia de trabalho).

export interface DrawingStore {
  load(): Promise<string | null>;
  save(json: string, key?: string): Promise<void>;
}

const DB_NAME = 'draw4fun';
/** Banco de quando o app se chamava Rabisco: o conteúdo vem para o novo na primeira abertura. */
const LEGACY_DB_NAME = 'rabisco';
const STORE = 'drawings';
const CURRENT_KEY = 'current';

function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('não abriu o IndexedDB'));
  });
}

/** Todos os pares chave/valor guardados (o desenho atual e as cópias de segurança). */
function readAll(db: IDBDatabase): Promise<[IDBValidKey, unknown][]> {
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    const keys = store.getAllKeys();
    const values = store.getAll();
    values.onsuccess = () => resolve(keys.result.map((k, i) => [k, values.result[i]]));
    values.onerror = () => reject(values.error ?? new Error('falha ao ler'));
  });
}

export class IndexedDbStore implements DrawingStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private factory: IDBFactory = indexedDB) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= openDb(this.factory, DB_NAME).then(async (db) => {
      await this.migrateLegacy(db);
      return db;
    });
    return this.db;
  }

  /**
   * Se o banco novo está vazio e existe o do tempo do Rabisco, copia tudo para o novo e
   * apaga o antigo. Uma falha aqui não impede de abrir: só fica sem o desenho antigo.
   */
  private async migrateLegacy(db: IDBDatabase): Promise<void> {
    try {
      if ((await readAll(db)).length > 0) return;
      const names = (await this.factory.databases?.())?.map((d) => d.name) ?? [];
      if (!names.includes(LEGACY_DB_NAME)) return;
      const legacy = await openDb(this.factory, LEGACY_DB_NAME);
      const entries = await readAll(legacy);
      legacy.close();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        for (const [key, value] of entries) tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('falha ao copiar'));
      });
      await new Promise<void>((resolve) => {
        const req = this.factory.deleteDatabase(LEGACY_DB_NAME);
        // Bloqueado (outra aba com ele aberto) não é erro: o conteúdo já foi copiado.
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    } catch (e) {
      console.warn('Não deu para trazer o desenho do banco antigo', e);
    }
  }

  async load(): Promise<string | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(CURRENT_KEY);
      req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null);
      req.onerror = () => reject(req.error ?? new Error('falha ao ler'));
    });
  }

  async save(json: string, key = CURRENT_KEY): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(json, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('falha ao salvar'));
    });
  }
}

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error';

/**
 * Junta várias mudanças seguidas num salvamento só, `delayMs` depois da última.
 * Um traço livre gera dezenas de mudanças por segundo: não dá para salvar a cada uma.
 */
export class Autosaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> = Promise.resolve();
  private inFlight = 0;

  constructor(
    private store: DrawingStore,
    private snapshot: () => string,
    private onStatus: (s: SaveStatus) => void = () => {},
    private delayMs = 500,
  ) {}

  /** Há mudança ainda não gravada (esperando o atraso ou gravando agora). */
  get hasPending(): boolean {
    return this.timer !== null || this.inFlight > 0;
  }

  schedule(): void {
    this.onStatus('pending');
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  /** Salva já o que estiver pendente (por exemplo, ao fechar a aba). */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.inFlight += 1;
    this.running = this.running.then(async () => {
      this.onStatus('saving');
      try {
        await this.store.save(this.snapshot());
        this.onStatus(this.timer === null ? 'saved' : 'pending');
      } catch (e) {
        console.error('Falha ao salvar o desenho', e);
        this.onStatus('error');
      } finally {
        this.inFlight -= 1;
      }
    });
    return this.running;
  }
}

const EMERGENCY_KEY = 'draw4fun:nao-salvo';

/**
 * Cópia de emergência, síncrona, para quando a aba fecha ou recarrega com mudança pendente.
 * O IndexedDB é assíncrono e o navegador pode cortar a gravação no meio do fechamento;
 * o `localStorage` grava na hora. Na próxima abertura, a cópia vale mais que o IndexedDB.
 */
export class EmergencyBackup {
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeLocalStorage()) {}

  /** Devolve `false` se não coube (o `localStorage` tem poucos MB; imagens grandes podem estourar). */
  write(json: string): boolean {
    try {
      this.storage?.setItem(EMERGENCY_KEY, json);
      return this.storage !== null;
    } catch {
      return false;
    }
  }

  read(): string | null {
    try {
      return this.storage?.getItem(EMERGENCY_KEY) ?? null;
    } catch {
      return null;
    }
  }

  clear(): void {
    try {
      this.storage?.removeItem(EMERGENCY_KEY);
    } catch {
      // Sem acesso ao armazenamento: não há o que limpar.
    }
  }
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Chaves de quando o app se chamava Rabisco e as novas. */
export const LEGACY_LOCAL_KEYS: readonly [string, string][] = [
  ['rabisco:nao-salvo', 'draw4fun:nao-salvo'],
  ['rabisco:drive-estado', 'draw4fun:drive-estado'],
  ['rabisco:drive-conectado', 'draw4fun:drive-conectado'],
];
export const LEGACY_SESSION_KEYS: readonly [string, string][] = [
  ['rabisco:google-token', 'draw4fun:google-token'],
  ['rabisco:google-state', 'draw4fun:google-state'],
];

/**
 * Passa os valores das chaves antigas para as novas (sem sobrescrever uma nova que já
 * exista) e apaga as antigas. Chame antes de qualquer leitura, ao abrir a página.
 */
export function migrateLegacyKeys(storage: KeyValue | null, pairs: readonly [string, string][]): void {
  if (!storage) return;
  for (const [from, to] of pairs) {
    try {
      const value = storage.getItem(from);
      if (value === null) continue;
      if (storage.getItem(to) === null) storage.setItem(to, value);
      storage.removeItem(from);
    } catch {
      // Sem espaço ou sem acesso: fica a chave antiga, nada se perde.
    }
  }
  try {
    storage.removeItem('rabisco:diagrama-rascunho');
  } catch {
    // Nada a limpar.
  }
}

/** Migra as chaves do `localStorage` e do `sessionStorage` desta aba. */
export function migrateLegacyStorage(): void {
  migrateLegacyKeys(safeLocalStorage(), LEGACY_LOCAL_KEYS);
  let session: Storage | null = null;
  try {
    session = globalThis.sessionStorage ?? null;
  } catch {
    session = null;
  }
  migrateLegacyKeys(session, LEGACY_SESSION_KEYS);
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
