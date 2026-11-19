// Cliente mínimo da API REST do Google Drive (v3), só com o que a sincronização usa.
// O token vem de fora (`getToken`), e o `fetch` pode ser trocado nos testes.

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export const FOLDER_NAME = 'draw4fun';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Marca nos arquivos do quadro, para achar os nossos sem depender do nome. */
const BOARD_PROPERTY = { key: 'draw4fun', value: 'board' } as const;

// Nomes de quando o app se chamava Rabisco. Quadros e pastas com eles continuam sendo
// achados e são renomeados na primeira sincronização (mesmo arquivo, mesmo conteúdo).
export const LEGACY_FOLDER_NAME = 'Rabisco';
const LEGACY_BOARD_KEY = 'rabisco';

export interface RemoteFile {
  id: string;
  /** Número que o Drive aumenta a cada mudança do arquivo (vem como texto). */
  version: string;
  /** Quadro ainda com a marca de quando o app se chamava Rabisco (precisa migrar). */
  legacy?: boolean;
  /** Pastas onde o arquivo está. */
  parents?: string[];
}

export interface RemoteBoard extends RemoteFile {
  name: string;
  modifiedTime: string;
}

/** O que a sincronização precisa do Drive. A implementação falsa dos testes segue isto. */
export interface DriveLike {
  findFolder(): Promise<string | null>;
  createFolder(): Promise<string>;
  /** Quadros na pasta, do modificado mais recentemente para o mais antigo. */
  findBoards(folderId: string): Promise<RemoteBoard[]>;
  /** `null` se o arquivo não existe mais ou está na lixeira. */
  getMeta(fileId: string): Promise<RemoteFile | null>;
  download(fileId: string): Promise<string>;
  create(folderId: string, name: string, json: string): Promise<RemoteFile>;
  update(fileId: string, json: string): Promise<RemoteFile>;
  /**
   * Traz um quadro do tempo do Rabisco para o nome novo: renomeia o arquivo para `name`,
   * troca a marca e renomeia a pasta "Rabisco" onde ele está.
   */
  migrateLegacy(fileId: string, name: string, parents: string[]): Promise<void>;
}

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

/** Token recusado ou vencido: é preciso entrar de novo. */
export class DriveAuthError extends DriveError {
  constructor(message = 'Acesso ao Drive expirou.') {
    super(message, 401);
    this.name = 'DriveAuthError';
  }
}

type Fetch = typeof fetch;

export class DriveApi implements DriveLike {
  constructor(
    private getToken: () => Promise<string>,
    private fetchFn: Fetch = (...args) => fetch(...args),
  ) {}

  /** Acha a pasta pelo nome; se só existir a do tempo do Rabisco, renomeia e usa ela. */
  async findFolder(): Promise<string | null> {
    const q = `mimeType='${FOLDER_MIME}' and (name='${FOLDER_NAME}' or name='${LEGACY_FOLDER_NAME}') and trashed=false`;
    const res = await this.json<{ files: { id: string; name: string }[] }>(
      `${API}/files?${params({ q, fields: 'files(id,name)', spaces: 'drive' })}`,
    );
    const current = res.files.find((f) => f.name === FOLDER_NAME);
    if (current) return current.id;
    const legacy = res.files[0];
    if (!legacy) return null;
    await this.rename(legacy.id, { name: FOLDER_NAME });
    return legacy.id;
  }

  async createFolder(): Promise<string> {
    const res = await this.json<{ id: string }>(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
    });
    return res.id;
  }

  async findBoards(folderId: string): Promise<RemoteBoard[]> {
    const q =
      `'${folderId}' in parents and trashed=false and (` +
      `appProperties has { key='${BOARD_PROPERTY.key}' and value='${BOARD_PROPERTY.value}' } or ` +
      `appProperties has { key='${LEGACY_BOARD_KEY}' and value='${BOARD_PROPERTY.value}' })`;
    const res = await this.json<{ files: RemoteBoard[] }>(
      `${API}/files?${params({ q, orderBy: 'modifiedTime desc', fields: 'files(id,name,version,modifiedTime)', spaces: 'drive' })}`,
    );
    return res.files;
  }

  async getMeta(fileId: string): Promise<RemoteFile | null> {
    try {
      const res = await this.json<RemoteFile & { trashed: boolean; appProperties?: Record<string, string>; parents?: string[] }>(
        `${API}/files/${encodeURIComponent(fileId)}?fields=id,version,trashed,appProperties,parents`,
      );
      if (res.trashed) return null;
      const props = res.appProperties ?? {};
      const legacy = props[LEGACY_BOARD_KEY] === BOARD_PROPERTY.value && props[BOARD_PROPERTY.key] !== BOARD_PROPERTY.value;
      return { id: res.id, version: res.version, legacy, parents: res.parents ?? [] };
    } catch (e) {
      if (e instanceof DriveError && e.status === 404) return null;
      throw e;
    }
  }

  async download(fileId: string): Promise<string> {
    const res = await this.request(`${API}/files/${encodeURIComponent(fileId)}?alt=media`);
    return res.text();
  }

  async create(folderId: string, name: string, json: string): Promise<RemoteFile> {
    const boundary = `draw4fun-${Math.random().toString(36).slice(2)}`;
    const metadata = {
      name,
      mimeType: 'application/json',
      parents: [folderId],
      appProperties: { [BOARD_PROPERTY.key]: BOARD_PROPERTY.value },
    };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--`;
    return this.json<RemoteFile>(`${UPLOAD}/files?uploadType=multipart&fields=id,version`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  async update(fileId: string, json: string): Promise<RemoteFile> {
    return this.json<RemoteFile>(`${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,version`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: json,
    });
  }

  async migrateLegacy(fileId: string, name: string, parents: string[]): Promise<void> {
    await this.rename(fileId, {
      name,
      // `null` apaga a marca antiga.
      appProperties: { [BOARD_PROPERTY.key]: BOARD_PROPERTY.value, [LEGACY_BOARD_KEY]: null },
    });
    for (const parent of parents) {
      const folder = await this.json<{ name: string }>(`${API}/files/${encodeURIComponent(parent)}?fields=name`);
      if (folder.name === LEGACY_FOLDER_NAME) await this.rename(parent, { name: FOLDER_NAME });
    }
  }

  /** Muda só os metadados (nome, marcas) de um arquivo ou pasta. */
  private async rename(id: string, metadata: Record<string, unknown>): Promise<void> {
    await this.json<{ id: string }>(`${API}/files/${encodeURIComponent(id)}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
  }

  private async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(url, init);
    return (await res.json()) as T;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getToken();
    const res = await this.fetchFn(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
    });
    if (res.ok) return res;
    const message = await errorMessage(res);
    if (res.status === 401) throw new DriveAuthError(message);
    throw new DriveError(message, res.status);
  }
}

function params(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `Drive respondeu ${res.status}`;
  } catch {
    return `Drive respondeu ${res.status}`;
  }
}
