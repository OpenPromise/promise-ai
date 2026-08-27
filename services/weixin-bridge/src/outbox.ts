import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const OUTBOX_MAX_ENTRIES = 20;
export const OUTBOX_DRAIN_INTERVAL_MS = 15_000;

export interface OutboxEntry {
  peer: string;
  text: string;
  ts: number;
  event: string;
}

/**
 * 未送达的 engineer.task.done（收工通知）落盘队列。
 * 进度消息太吵，故意不入队。
 */
export class DoneOutbox {
  readonly #file: string;
  #entries: OutboxEntry[] = [];
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  static async open(file: string): Promise<DoneOutbox> {
    const box = new DoneOutbox(file);
    await box.#load();
    return box;
  }

  async #load(): Promise<void> {
    try {
      const raw = await readFile(this.#file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        this.#entries = parsed.filter(isOutboxEntry);
      }
    } catch {
      // 文件不存在或损坏 -> 空队列
    }
  }

  peek(): OutboxEntry[] {
    return this.#entries.map((entry) => ({ ...entry }));
  }

  get size(): number {
    return this.#entries.length;
  }

  async enqueue(entry: OutboxEntry): Promise<void> {
    this.#entries.push(entry);
    if (this.#entries.length > OUTBOX_MAX_ENTRIES) {
      this.#entries.splice(0, this.#entries.length - OUTBOX_MAX_ENTRIES);
    }
    await this.#save();
  }

  async replace(entries: OutboxEntry[]): Promise<void> {
    this.#entries = [...entries];
    await this.#save();
  }

  async #save(): Promise<void> {
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
    await writeFile(tmp, JSON.stringify(this.#entries, null, 2), 'utf8');
    await rename(tmp, this.#file);
  }
}

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.peer === 'string' &&
    typeof entry.text === 'string' &&
    typeof entry.ts === 'number' &&
    typeof entry.event === 'string'
  );
}
