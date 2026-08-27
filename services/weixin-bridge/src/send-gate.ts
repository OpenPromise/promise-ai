/**
 * 进程内 iLink sendMessage 串行闸门：同一时刻只允许一条 in-flight，
 * 两次尝试之间至少间隔 SEND_MIN_GAP_MS，避免 progress 与收工通知撞车
 * 触发 `sendMessage ret=-2 prepare failed`。
 */

export const SEND_MIN_GAP_MS = 400;

export interface SendGateClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

function defaultClock(): SendGateClock {
  return {
    now: () => Date.now(),
    sleep: (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
  };
}

export class SendGate {
  readonly minGapMs: number;
  readonly #clock: SendGateClock;
  #tail: Promise<void> = Promise.resolve();
  /** 上次尝试结束时刻；负无穷表示还没发过，第一条立刻走。 */
  #lastEndAt = Number.NEGATIVE_INFINITY;

  constructor(options: { minGapMs?: number; clock?: SendGateClock } = {}) {
    this.minGapMs = options.minGapMs ?? SEND_MIN_GAP_MS;
    this.#clock = options.clock ?? defaultClock();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      const wait = this.#lastEndAt + this.minGapMs - this.#clock.now();
      if (wait > 0) await this.#clock.sleep(wait);
      return await fn();
    } finally {
      this.#lastEndAt = this.#clock.now();
      release();
    }
  }
}

/** 进程级单例：event-pusher 与 relay 回复共用。 */
export const processSendGate = new SendGate();
