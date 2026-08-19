import type { InMemoryReminderStore } from '@personal-ai/tools';

export interface ReminderDueEvent {
  id: string;
  text: string;
  dueAt?: string;
}

export interface ReminderServiceDeps {
  reminders: InMemoryReminderStore;
  intervalMs?: number;
}

export const REMINDER_TICK_MS = 10_000;

/**
 * 提醒投递服务：定时扫描到期提醒（dueAt <= now 且未完成），标记完成后
 * 广播 `reminder.due` 事件，由 SSE 推送给桌面端弹系统通知。
 * 补上 reminder.create 只存不送的缺口。
 */
export class ReminderService {
  readonly #reminders: InMemoryReminderStore;
  readonly #intervalMs: number;
  readonly #listeners = new Set<(event: ReminderDueEvent) => void>();
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: ReminderServiceDeps) {
    this.#reminders = deps.reminders;
    this.#intervalMs = deps.intervalMs ?? REMINDER_TICK_MS;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.checkNow(), this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** 订阅提醒到期事件；返回取消订阅函数。 */
  onDue(listener: (event: ReminderDueEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 扫描一次到期提醒（公开便于测试确定性触发）。 */
  checkNow(): void {
    const now = Date.now();
    for (const reminder of this.#reminders.list(false)) {
      if (reminder.dueAt === undefined || Date.parse(reminder.dueAt) > now) continue;
      this.#reminders.markDone(reminder.id);
      this.#emit({
        id: reminder.id,
        text: reminder.text,
        ...(reminder.dueAt ? { dueAt: reminder.dueAt } : {}),
      });
    }
  }

  #emit(event: ReminderDueEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者出错不影响其他订阅者
      }
    }
  }
}
