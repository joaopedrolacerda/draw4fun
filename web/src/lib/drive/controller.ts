// Junta login, Drive e motor de sincronização, e decide quando sincronizar:
// alguns segundos depois de cada mudança local, a cada meio minuto, e quando a aba
// volta ao foco ou a internet volta (a interface chama `syncNow` nesses casos).

import type { DriveLike } from './api';
import { SyncEngine, type SyncState, type SyncStatus } from './sync';

/** Estado mostrado na interface. */
export type DriveUiState = 'off' | 'connecting' | SyncStatus;

export interface AuthLike {
  readonly hasValidToken: boolean;
  connect(mode: 'consent' | 'silent'): Promise<void>;
  invalidate(): void;
  disconnect(): Promise<void>;
}

/** Lembra entre sessões que este navegador estava conectado (para mostrar "Reconectar"). */
export interface Flag {
  get(): boolean;
  set(value: boolean): void;
}

export interface DriveControllerDeps {
  auth: AuthLike;
  drive: DriveLike;
  getJson(): string;
  mergeRemote(json: string): void;
  stateStore: { load(): SyncState | null; save(state: SyncState): void };
  connectedFlag: Flag;
  onState(state: DriveUiState, detail?: string): void;
}

export class DriveController {
  private engine: SyncEngine;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(
    private deps: DriveControllerDeps,
    private options = { debounceMs: 2000, pollMs: 30_000 },
  ) {
    this.engine = new SyncEngine({
      drive: deps.drive,
      getJson: deps.getJson,
      mergeRemote: deps.mergeRemote,
      loadState: deps.stateStore.load,
      saveState: deps.stateStore.save,
      onStatus: (status, detail) => {
        if (status === 'needs-auth') deps.auth.invalidate();
        deps.onState(status, detail);
      },
    });
  }

  /** Link da pasta no Drive, depois da primeira sincronização. */
  get folderUrl(): string | null {
    const id = this.engine.folderId;
    return id ? `https://drive.google.com/drive/folders/${encodeURIComponent(id)}` : null;
  }

  /**
   * Ao abrir a página: com login válido (acabou de voltar do Google, ou recarregou dentro
   * da hora), já sincroniza; senão mostra "Entrar" ou, se já entrou antes, "Reconectar".
   */
  async start(): Promise<void> {
    if (this.deps.auth.hasValidToken) {
      this.deps.connectedFlag.set(true);
      this.startPolling();
      await this.engine.sync();
      return;
    }
    this.deps.onState(this.deps.connectedFlag.get() ? 'needs-auth' : 'off');
  }

  /** Entra com Google (chame de um clique) e já sincroniza. */
  async connect(mode: 'consent' | 'silent'): Promise<void> {
    const was = this.deps.connectedFlag.get();
    this.deps.onState('connecting');
    try {
      await this.deps.auth.connect(mode);
    } catch (e) {
      this.deps.onState(was ? 'needs-auth' : 'off', e instanceof Error ? e.message : 'Não foi possível entrar.');
      return;
    }
    this.deps.connectedFlag.set(true);
    this.startPolling();
    await this.engine.sync();
  }

  /** Houve mudança no desenho local. */
  localChange(): void {
    this.engine.markDirty();
    if (!this.deps.auth.hasValidToken) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.syncNow();
    }, this.options.debounceMs);
  }

  /** Sincroniza agora, se houver login válido; sem login, só mostra o estado certo. */
  async syncNow(): Promise<void> {
    if (!this.deps.auth.hasValidToken) {
      if (this.deps.connectedFlag.get()) this.deps.onState('needs-auth');
      return;
    }
    await this.engine.sync();
  }

  /** Sai da conta: revoga o acesso, esquece o arquivo e para de sincronizar. */
  async disconnect(): Promise<void> {
    this.stopTimers();
    await this.deps.auth.disconnect();
    this.deps.connectedFlag.set(false);
    this.engine.reset();
    this.deps.onState('off');
  }

  dispose(): void {
    this.stopTimers();
  }

  private startPolling(): void {
    if (this.poll !== null) return;
    this.poll = setInterval(() => void this.syncNow(), this.options.pollMs);
  }

  private stopTimers(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    if (this.poll !== null) clearInterval(this.poll);
    this.debounce = null;
    this.poll = null;
  }
}

/** Marca "estava conectado" no `localStorage`. */
export function localFlag(key = 'draw4fun:drive-conectado'): Flag {
  return {
    get() {
      try {
        return globalThis.localStorage?.getItem(key) === '1';
      } catch {
        return false;
      }
    },
    set(value) {
      try {
        if (value) globalThis.localStorage?.setItem(key, '1');
        else globalThis.localStorage?.removeItem(key);
      } catch {
        // Sem armazenamento: só não lembra entre sessões.
      }
    },
  };
}
