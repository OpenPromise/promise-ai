import { CronExpressionParser } from 'cron-parser';
import {
  SessionNotFoundError,
  type SessionStore,
  type Task,
  type TaskStore,
  type TimelineStore,
} from '@personal-ai/memory';
import type { ConversationService } from './conversation.js';

export interface TaskServiceDeps {
  tasks: TaskStore;
  sessions: SessionStore;
  conversation: ConversationService;
  systemPrompt: () => Promise<string>;
  /** 事件时间线：任务完成/失败留痕。 */
  timeline?: TimelineStore;
  tickIntervalMs?: number;
  /** 同一 tick 内并发执行的到期任务上限（默认 2）；其余排队。 */
  maxConcurrentRuns?: number;
}

/** 任务一次运行的结果，用于推送给桌面端（通知闭环）。 */
export interface TaskRunEvent {
  taskId: string;
  taskName: string;
  schedule: string;
  action: string;
  status: 'success' | 'error';
  output?: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export const TICK_INTERVAL_MS = 30_000;
/** 无人值守任务的工具调用预算（防跑飞，OpenClaw tool_budget_exceeded 思路）。 */
export const TASK_TOOL_BUDGET = 10;
/**
 * 同一 tick 内并发执行的到期任务上限（其余排队）。
 * 之前是串行 await：一个跑十分钟的任务（server.shell 长命令 / coding.run）会把
 * 同 tick 内其它到期任务全部推迟——队头阻塞。上限 2 与 engineer-task-runner 一致，
 * 既消除队头阻塞，又不至于让若干个重任务同时抢服务器资源。
 */
export const MAX_CONCURRENT_TASK_RUNS = 2;

/**
 * 有界并发执行：最多 limit 个 worker 从同一份列表取任务，其余排队。
 * 单项抛错不影响其它项（run 内部自行兜底）。
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor]!;
      cursor += 1;
      await run(item);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker);
  await Promise.all(workers);
}

/**
 * A task is due when the next occurrence after its creation (or last run) has
 * already passed `now`. Basing the computation on `lastRunAt`/`createdAt`
 * prevents re-firing the same occurrence across ticks.
 */
export function isTaskDue(task: Task, now: Date): boolean {
  const start = task.lastRunAt ? new Date(task.lastRunAt) : new Date(task.createdAt);
  const interval = CronExpressionParser.parse(task.schedule, { currentDate: start });
  const next = interval.next().toDate();
  return next.getTime() <= now.getTime();
}

export function validateCronSchedule(schedule: string): string | null {
  try {
    CronExpressionParser.parse(schedule);
    return null;
  } catch {
    return `无效的 cron 表达式：${schedule}`;
  }
}

/**
 * Node.js scheduler (Phase 8, first stage — no queue system yet). Every tick it
 * finds due tasks and runs them headlessly through the agent loop.
 */
export class TaskService {
  readonly #tasks: TaskStore;
  readonly #sessions: SessionStore;
  readonly #conversation: ConversationService;
  readonly #systemPrompt: () => Promise<string>;
  readonly #timeline?: TimelineStore;
  readonly #tickIntervalMs: number;
  readonly #maxConcurrentRuns: number;
  readonly #listeners = new Set<(event: TaskRunEvent) => void>();
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;

  constructor(deps: TaskServiceDeps) {
    this.#tasks = deps.tasks;
    this.#sessions = deps.sessions;
    this.#conversation = deps.conversation;
    this.#systemPrompt = deps.systemPrompt;
    this.#timeline = deps.timeline;
    this.#tickIntervalMs = deps.tickIntervalMs ?? TICK_INTERVAL_MS;
    this.#maxConcurrentRuns = Math.max(
      1,
      Math.floor(deps.maxConcurrentRuns ?? MAX_CONCURRENT_TASK_RUNS),
    );
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.checkNow(), this.#tickIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** 订阅任务运行事件；返回取消订阅函数。 */
  onRun(listener: (event: TaskRunEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async createTaskSession(_action: string): Promise<string> {
    const session = await this.#sessions.createSession({
      systemPrompt: await this.#systemPrompt(),
    });
    return session.id;
  }

  /** Runs the scheduler once; public so tests can trigger ticks deterministically. */
  async checkNow(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const tasks = await this.#tasks.listTasks();
      const now = new Date();
      const due = tasks.filter((task) => task.enabled && isTaskDue(task, now));
      // 有界并发 + 单任务兜底：一个慢任务不再拖垮同 tick 的其它任务，
      // 单任务抛错（含 getSession 的数据库抖动）也不会终止整个 tick。
      await runWithConcurrency(due, this.#maxConcurrentRuns, async (task) => {
        try {
          await this.#runTask(task);
        } catch (error) {
          console.error(
            `[tasks] task ${task.id}（${task.name}）run failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    } catch (error) {
      console.error(
        `[tasks] scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.#ticking = false;
    }
  }

  async #runTask(task: Task): Promise<void> {
    const startedAt = new Date().toISOString();
    // Mark as run first so overlapping ticks cannot double-fire.
    await this.#tasks.updateTask(task.id, { lastRunAt: startedAt });
    // 会话可能因存储切换/清理而丢失；重建一个专属会话，避免任务永远失败。
    try {
      await this.#sessions.getSession(task.sessionId);
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        const fresh = await this.#sessions.createSession({
          systemPrompt: await this.#systemPrompt(),
        });
        task = { ...task, sessionId: fresh.id };
        await this.#tasks.updateTask(task.id, { sessionId: fresh.id });
      } else {
        throw error;
      }
    }
    const finishedAt = () => new Date().toISOString();
    try {
      let output = '';
      for await (const envelope of this.#conversation.runChat({
        sessionId: task.sessionId,
        userMessage: task.action,
        headless: true,
        toolAllowlist: task.tools,
        toolBudget: TASK_TOOL_BUDGET,
      })) {
        if (envelope.type === 'chat.token') {
          output += (envelope.payload as { delta?: string }).delta ?? '';
        } else if (envelope.type === 'chat.done') {
          const text = (envelope.payload as { text?: string }).text;
          if (text) output = text;
        }
      }
      const run = await this.#tasks.addRun({
        taskId: task.id,
        status: 'success',
        output,
        startedAt,
        finishedAt: finishedAt(),
      });
      void this.#timeline?.addEvent({
        type: 'task',
        summary: `定时任务「${task.name}」完成${output.trim() ? `：${output.trim().slice(0, 100)}` : ''}`,
        runId: run.id,
      });
      this.#emit({
        taskId: task.id,
        taskName: task.name,
        schedule: task.schedule,
        action: task.action,
        status: 'success',
        output,
        startedAt,
        finishedAt: finishedAt(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const run = await this.#tasks.addRun({
        taskId: task.id,
        status: 'error',
        error: message,
        startedAt,
        finishedAt: finishedAt(),
      });
      void this.#timeline?.addEvent({
        type: 'task',
        summary: `定时任务「${task.name}」失败：${message.slice(0, 100)}`,
        runId: run.id,
      });
      this.#emit({
        taskId: task.id,
        taskName: task.name,
        schedule: task.schedule,
        action: task.action,
        status: 'error',
        error: message,
        startedAt,
        finishedAt: finishedAt(),
      });
    }
  }

  #emit(event: TaskRunEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者出错不影响其他订阅者与调度器
      }
    }
  }
}
