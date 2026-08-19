import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface AccountState {
  token: string;
  baseUrl: string;
  accountId: string;
  /** 扫码用户的微信 id（用于记录/白名单）。 */
  userId?: string;
  /** getUpdates 同步游标，重启后续接。 */
  syncBuf?: string;
  /** 微信对端 -> agent-server sessionId。 */
  peerSessions: Record<string, string>;
  savedAt: string;
}

export interface BridgeState {
  account?: AccountState;
}

export class StateStore {
  readonly #file: string;
  #state: BridgeState;

  constructor(file: string) {
    this.#file = file;
    this.#state = {};
  }

  static async open(file: string): Promise<StateStore> {
    const store = new StateStore(file);
    await store.#load();
    return store;
  }

  async #load(): Promise<void> {
    try {
      const raw = await readFile(this.#file, 'utf8');
      const parsed = JSON.parse(raw) as BridgeState;
      if (parsed && typeof parsed === 'object') this.#state = parsed;
    } catch {
      // 文件不存在或损坏 -> 空状态
    }
  }

  get account(): AccountState | undefined {
    return this.#state.account;
  }

  async setAccount(account: AccountState): Promise<void> {
    this.#state.account = account;
    await this.save();
  }

  async clearAccount(): Promise<void> {
    this.#state.account = undefined;
    await this.save();
  }

  async save(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#state, null, 2), 'utf8');
    await rename(tmp, this.#file);
  }
}
