// Sincronização do quadro com o Google Drive.
//
// A cópia de trabalho é sempre a local; o Drive é onde os aparelhos se encontram.
// A cada rodada:
//   1. se o arquivo no Drive mudou desde a última vez (o `version` dele é outro),
//      baixa e junta com o local pelo merge do núcleo (elemento por elemento);
//   2. se há mudança local ainda não enviada (ou o merge trouxe algo que o Drive não tem),
//      envia o quadro inteiro.
// Como cada aparelho guarda tudo e o merge não perde nada, uma corrida entre dois envios
// se resolve sozinha na rodada seguinte de quem perdeu.

import { type DriveLike, DriveAuthError } from './api';
import { NeedsAuthError } from './auth';

export const BOARD_FILE_NAME = 'Meu quadro.draw4fun';

export interface SyncState {
  folderId: string | null;
  fileId: string | null;
  /** `version` do arquivo no Drive na última vez que baixamos ou enviamos. */
  remoteVersion: string | null;
  /** Há mudança local que ainda não foi para o Drive. Guardado para sobreviver a recarregar. */
  dirty: boolean;
}

export const emptyState = (): SyncState => ({ folderId: null, fileId: null, remoteVersion: null, dirty: true });

export type SyncStatus = 'syncing' | 'synced' | 'offline' | 'needs-auth' | 'error';

export interface SyncDeps {
  drive: DriveLike;
  /** JSON atual do quadro local. */
  getJson(): string;
  /** Junta no quadro local uma cópia vinda do Drive. Lança erro se não conseguir ler. */
  mergeRemote(json: string): void;
  loadState(): SyncState | null;
  saveState(state: SyncState): void;
  onStatus(status: SyncStatus, detail?: string): void;
}

export class SyncEngine {
  private state: SyncState;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private deps: SyncDeps) {
    this.state = deps.loadState() ?? emptyState();
  }

  get folderId(): string | null {
    return this.state.folderId;
  }

  get hasPendingChanges(): boolean {
    return this.state.dirty;
  }

  /** Houve mudança local: a próxima rodada envia. */
  markDirty(): void {
    if (this.state.dirty) return;
    this.state = { ...this.state, dirty: true };
    this.deps.saveState(this.state);
  }

  /** Esquece o arquivo (ao sair): a próxima conta conectada começa do zero. */
  reset(): void {
    this.state = emptyState();
    this.deps.saveState(this.state);
  }

  /**
   * Roda uma sincronização. Se já houver uma rodando, marca para rodar mais uma em seguida
   * (com o que mudou no meio) e devolve a mesma promessa.
   */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.round();
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async round(): Promise<void> {
    const { drive } = this.deps;
    this.deps.onStatus('syncing');
    let uploading = false;
    try {
      let { fileId, remoteVersion } = this.state;
      let remoteJson: string | null = null;

      if (!fileId) {
        // Primeira vez neste aparelho: talvez outro aparelho já tenha criado o quadro.
        const folderId = await this.folder();
        const [existing] = await drive.findBoards(folderId);
        if (existing) {
          fileId = existing.id;
          remoteVersion = null;
        }
      }

      if (fileId) {
        const meta = await drive.getMeta(fileId);
        if (meta?.legacy) await this.migrate(fileId, meta.parents ?? []);
        if (!meta) {
          // Apagado ou na lixeira no Drive: o local vira um arquivo novo lá.
          fileId = null;
          remoteVersion = null;
        } else if (meta.version !== remoteVersion) {
          remoteJson = await drive.download(fileId);
          try {
            this.deps.mergeRemote(remoteJson);
          } catch (e) {
            // Não sobrescreve no Drive um arquivo que não conseguimos ler (pode ser de uma
            // versão mais nova do app): para tudo e avisa.
            throw new UnreadableRemoteError(e);
          }
          remoteVersion = meta.version;
        }
      }
      this.state = { ...this.state, fileId, remoteVersion };

      const json = this.deps.getJson();
      const needsUpload = !fileId || this.state.dirty || (remoteJson !== null && json !== remoteJson);
      if (needsUpload) {
        uploading = true;
        // Mudanças feitas durante o envio marcam `dirty` de novo e entram na próxima rodada.
        this.state = { ...this.state, dirty: false };
        const sent = fileId
          ? await drive.update(fileId, json)
          : await drive.create(await this.folder(), BOARD_FILE_NAME, json);
        this.state = { ...this.state, fileId: sent.id, remoteVersion: sent.version };
      }
      this.deps.saveState(this.state);
      this.deps.onStatus(this.state.dirty ? 'syncing' : 'synced');
    } catch (e) {
      if (uploading) this.state = { ...this.state, dirty: true };
      this.deps.saveState(this.state);
      this.report(e);
    }
  }

  /**
   * Quadro do tempo em que o app se chamava Rabisco: renomeia arquivo e pasta. Se falhar,
   * a sincronização segue normal e tenta de novo na próxima rodada.
   */
  private async migrate(fileId: string, parents: string[]): Promise<void> {
    try {
      await this.deps.drive.migrateLegacy(fileId, BOARD_FILE_NAME, parents);
    } catch (e) {
      if (e instanceof NeedsAuthError || e instanceof DriveAuthError) throw e;
      console.warn('Não deu para renomear o quadro antigo no Drive', e);
    }
  }

  private async folder(): Promise<string> {
    if (this.state.folderId) return this.state.folderId;
    const { drive } = this.deps;
    const folderId = (await drive.findFolder()) ?? (await drive.createFolder());
    this.state = { ...this.state, folderId };
    return folderId;
  }

  private report(e: unknown): void {
    if (e instanceof NeedsAuthError || e instanceof DriveAuthError) {
      this.deps.onStatus('needs-auth');
    } else if (e instanceof TypeError || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      // `fetch` lança TypeError quando não há rede.
      this.deps.onStatus('offline');
    } else if (e instanceof UnreadableRemoteError) {
      console.error(e.cause);
      this.deps.onStatus('error', 'O quadro no Drive não pôde ser lido. Nada foi sobrescrito.');
    } else {
      console.error(e);
      this.deps.onStatus('error', e instanceof Error ? e.message : 'Erro ao sincronizar.');
    }
  }
}

class UnreadableRemoteError extends Error {
  constructor(cause: unknown) {
    super('arquivo remoto ilegível', { cause });
    this.name = 'UnreadableRemoteError';
  }
}

/** Guarda o estado da sincronização no `localStorage` (pequeno: só ids e versão). */
export function localSyncStateStore(key = 'draw4fun:drive-estado') {
  return {
    load(): SyncState | null {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw ? { ...emptyState(), ...(JSON.parse(raw) as Partial<SyncState>) } : null;
      } catch {
        return null;
      }
    },
    save(state: SyncState): void {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(state));
      } catch {
        // Sem armazenamento: a sincronização só recomeça do zero na próxima vez.
      }
    },
  };
}
