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
  /** 事件推送已处理的 SSE id，容器重启后带 Last-Event-ID 重放缓冲的 done。 */
  lastEventId?: string;
}

export class StateStore {
  readonly #file: string;
  #state: BridgeState;
  /**
   * 写入串行化队列：save() 之间共用同一个 `.tmp` 文件，两次并发写会互相覆盖
   * 半成品，先 rename 的那次可能把另一次尚未写完的内容改成正式文件（状态损坏，
   * 严重时 token 丢失需重新扫码）。用一条 promise 链把写入排成队即可，
   * 无需引入锁库。
   */
  #writeQueue: Promise<void> = Promise.resolve();

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

  get lastEventId(): string {
    return this.#state.lastEventId ?? '';
  }

  async setAccount(account: AccountState): Promise<void> {
    this.#state.account = account;
    await this.save();
  }

  async setLastEventId(id: string): Promise<void> {
    // 只在前进时落盘；空 id（新登录）不写，避免带着空头去重放。
    if (!id || id === this.#state.lastEventId) return;
    this.#state.lastEventId = id;
    await this.save();
  }

  async clearAccount(): Promise<void> {
    this.#state.account = undefined;
    this.#state.lastEventId = undefined;
    await this.save();
  }

  async save(): Promise<void> {
    // 排到队尾：前一次写入（含 rename）完成后才开始，失败也不阻塞后续写入。
    const run = this.#writeQueue.then(
      () => this.#writeNow(),
      () => this.#writeNow(),
    );
    this.#writeQueue = run.catch(() => {});
    await run;
  }

  async #writeNow(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#state, null, 2), 'utf8');
    await rename(tmp, this.#file);
  }
}
