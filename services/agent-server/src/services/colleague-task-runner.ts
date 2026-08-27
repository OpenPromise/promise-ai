import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TimelineStore } from '@personal-ai/memory';
import {
  runDshHeadless,
  type DshRunResult,
  type RunDshOptions,
} from './coding-tool.js';

/**
 * 同事异步任务执行器（从 EngineerTaskRunner 抽出）：*.delegate 只负责
 * "创建任务并立即返回"，dsh 在后台独立运行，输出流式解析成进度事件，
 * 完成/失败通过事件推送到微信等渠道。小夜派完单就能继续陪用户聊天，
 * 不再被 15 分钟的子进程同步阻塞。小黑/小优/小美/小真/小知共用此实现。
 */

export type ColleaguePermissionMode = RunDshOptions['permissionMode'];

export interface ColleagueSpec {
  /** 短 id，用于持久化文件名（engineer / ops / designer / qa / research）。 */
  id: string;
  /** 展示名：小黑 / 小优 / 小美 / 小真 / 小知。 */
  name: string;
  permissionMode: ColleaguePermissionMode;
  buildTask: (userRequest: string) => string;
  startedText: string;
  /** 持久化文件名，默认 `${id}-tasks.json`。 */
  persistFileName?: string;
}

/** 内存任务表上限：超过后驱逐最旧的已完成/失败任务（running 永不驱逐）。 */
const MAX_TASKS = 100;

export type ColleagueTaskStatus = 'running' | 'success' | 'failed' | 'timeout';

export interface ColleagueTask {
  id: string;
  /** 同事展示名（小黑/小优/…），旧持久化记录可能缺失。 */
  colleague?: string;
  task: string;
  directory: string;
  status: ColleagueTaskStatus;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  /** 最近一次进度提示（最后一行有意义的输出）。 */
  progress?: string;
  /** 累计输出（截断保存，供查询/复盘）。 */
  output: string;
  /** 累计输出超过上限被截断（grok-build 思路：一旦置 true 不再回退）。 */
  truncated?: boolean;
  /** 成功时的结构化报告（截断）。 */
  result?: string;
  /** 失败/超时原因。 */
  error?: string;
  exitCode?: number | null;
}

export interface ColleagueTaskEvent {
  type: 'started' | 'progress' | 'done';
  taskId: string;
  status: ColleagueTaskStatus;
  colleague?: string;
  text?: string;
  result?: string;
  error?: string;
}

export type RunTaskFn = (taskText: string, options: RunDshOptions) => Promise<DshRunResult>;

export interface ColleagueFinishOutcome {
  status: 'success' | 'failed' | 'timeout';
  result?: string;
  error?: string;
  exitCode?: number | null;
}

export interface ColleagueTaskRunnerOptions {
  timeline?: TimelineStore;
  /** 持久化目录（任务记录存 JSON 文件，重启后可查询结果）。 */
  persistDir?: string;
  /** 进度事件最小间隔（毫秒），默认 20s，防止刷屏。 */
  progressIntervalMs?: number;
  /** dsh 累计输出保留上限（字符），默认 20_000。 */
  outputCap?: number;
  /** 并发上限（默认 2）：超限任务排队，前一个完成后自动出队。 */
  maxConcurrent?: number;
  /** 测试注入用；默认跑真实 dsh。 */
  runTask?: RunTaskFn;
  /** 任务结束回调（成功/失败/超时/启动失败）。审计等副作用挂这里。 */
  onFinish?: (task: ColleagueTask, outcome: ColleagueFinishOutcome) => void | Promise<void>;
}

/** 从累计输出里提取"最后一行有意义的进度"（去掉空行/纯分隔）。 */
export function lastMeaningfulLine(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[-=#*_]{3,}$/.test(line));
  return lines.at(-1)?.slice(0, 120);
}

/** 追加输出并截断保留尾部（保留最近内容，防止无限膨胀）。 */
export function appendCapped(current: string, chunk: string, cap: number): string {
  const next = current + chunk;
  if (next.length <= cap) return next;
  return next.slice(-cap);
}

export class ColleagueTaskRunner {
  readonly #spec: ColleagueSpec;
  readonly #tasks = new Map<string, ColleagueTask>();
  readonly #listeners = new Set<(event: ColleagueTaskEvent) => void>();
  readonly #timeline?: TimelineStore;
  readonly #persistFile?: string;
  readonly #progressIntervalMs: number;
  readonly #outputCap: number;
  readonly #maxConcurrent: number;
  readonly #runTask: RunTaskFn;
  readonly #onFinish?: ColleagueTaskRunnerOptions['onFinish'];
  /** 当前正在运行的 dsh 子进程数。 */
  #active = 0;
  /** 并发超限时排队的任务（FIFO），前一个完成/失败后出队。 */
  readonly #pending: Array<{ task: ColleagueTask; timeoutMinutes: number }> = [];
  /** 持久化写队列：串行化避免多个任务同时 finish 时并发写同一文件。 */
  #persistChain: Promise<void> = Promise.resolve();

  constructor(spec: ColleagueSpec, options: ColleagueTaskRunnerOptions = {}) {
    this.#spec = spec;
    this.#timeline = options.timeline;
    this.#progressIntervalMs = options.progressIntervalMs ?? 20_000;
    this.#outputCap = options.outputCap ?? 20_000;
    this.#maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 2));
    this.#runTask = options.runTask ?? runDshHeadless;
    this.#onFinish = options.onFinish;
    if (options.persistDir) {
      const fileName = spec.persistFileName ?? `${spec.id}-tasks.json`;
      this.#persistFile = path.join(options.persistDir, fileName);
    }
  }

  get spec(): ColleagueSpec {
    return this.#spec;
  }

  /**
   * 启动时加载已持久化的任务记录；残留 running（进程重启被杀）标记失败。
   * 返回中断任务列表，由调用方在事件通道（SSE 订阅）就绪后再补发 done——
   * 启动早期直接 emit 会发进虚空（监听器还没注册），中断通知将永久丢失。
   */
  async loadPersisted(): Promise<ColleagueTask[]> {
    const interrupted: ColleagueTask[] = [];
    if (!this.#persistFile) return interrupted;
    try {
      const raw = await readFile(this.#persistFile, 'utf8');
      const records = JSON.parse(raw) as ColleagueTask[];
      let changed = false;
      for (const record of records) {
        if (!record?.id) continue;
        if (!record.colleague) record.colleague = this.#spec.name;
        if (record.status === 'running') {
          record.status = 'failed';
          record.finishedAt = new Date().toISOString();
          record.error = '进程重启，任务中断';
          changed = true;
          interrupted.push(record);
        }
        this.#tasks.set(record.id, record);
      }
      if (changed) void this.#persist();
      return interrupted;
    } catch {
      return interrupted;
    }
  }

  /** 补发一次任务完成事件（供启动恢复：事件订阅就绪后调用）。 */
  emitTaskDone(taskId: string): void {
    const task = this.#tasks.get(taskId);
    if (!task || task.status === 'running') return;
    this.#emit({
      type: 'done',
      taskId,
      status: task.status,
      colleague: task.colleague ?? this.#spec.name,
      ...(task.result ? { result: task.result } : {}),
      ...(task.error ? { error: task.error } : {}),
    });
  }

  onEvent(listener: (event: ColleagueTaskEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get(id: string): ColleagueTask | undefined {
    return this.#tasks.get(id);
  }

  list(limit = 10): ColleagueTask[] {
    return [...this.#tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.floor(limit)));
  }

  /** 异步派单：立即返回运行中任务，dsh 在后台执行（不再阻塞对话）。 */
  async delegate(
    task: string,
    options: { directory?: string; timeoutMinutes?: number } = {},
  ): Promise<ColleagueTask> {
    const directory = path.resolve(options.directory ?? '/app');
    const timeoutMinutes = Math.min(Math.max(1, Math.floor(options.timeoutMinutes ?? 15)), 60);
    const record: ColleagueTask = {
      id: randomUUID(),
      colleague: this.#spec.name,
      task: task.trim(),
      directory,
      status: 'running',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      output: '',
    };
    this.#tasks.set(record.id, record);
    if (this.#tasks.size > MAX_TASKS) {
      const finished = [...this.#tasks.values()]
        .filter((item) => item.status !== 'running')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const overflow = this.#tasks.size - MAX_TASKS;
      for (const item of finished.slice(0, overflow)) {
        this.#tasks.delete(item.id);
      }
    }
    void this.#persist();
    this.#emit({
      type: 'started',
      taskId: record.id,
      status: 'running',
      colleague: this.#spec.name,
      text: this.#spec.startedText,
    });
    if (this.#active >= this.#maxConcurrent) {
      this.#pending.push({ task: record, timeoutMinutes });
    } else {
      void this.#run(record, timeoutMinutes);
    }
    return record;
  }

  async #run(task: ColleagueTask, timeoutMinutes: number): Promise<void> {
    this.#active += 1;
    try {
      await this.#runInner(task, timeoutMinutes);
    } finally {
      this.#active -= 1;
      const next = this.#pending.shift();
      if (next) void this.#run(next.task, next.timeoutMinutes);
    }
  }

  async #runInner(task: ColleagueTask, timeoutMinutes: number): Promise<void> {
    const name = this.#spec.name;
    const taskText = this.#spec.buildTask(task.task);
    let lastProgressAt = 0;
    const onData: RunDshOptions['onData'] = (chunk) => {
      if (task.output.length + chunk.length > this.#outputCap) {
        task.truncated = true;
      }
      task.output = appendCapped(task.output, chunk, this.#outputCap);
      const line = lastMeaningfulLine(task.output);
      if (line) {
        task.progress = line;
        const now = Date.now();
        if (now - lastProgressAt >= this.#progressIntervalMs) {
          lastProgressAt = now;
          this.#emit({
            type: 'progress',
            taskId: task.id,
            status: 'running',
            colleague: name,
            text: line,
          });
        }
      }
    };

    const timeoutMs = timeoutMinutes * 60 * 1000;
    let result: DshRunResult;
    try {
      result = await this.#runTask(taskText, {
        cwd: task.directory,
        timeoutMs,
        permissionMode: this.#spec.permissionMode,
        onData,
      });
    } catch (error) {
      this.#finish(task, {
        status: 'failed',
        error: `启动${name}失败：${error instanceof Error ? error.message : String(error)}`,
        exitCode: null,
      });
      return;
    }

    if (result.timedOut) {
      this.#finish(task, {
        status: 'timeout',
        error: `${name}执行超过 ${timeoutMinutes} 分钟被终止`,
        exitCode: result.exitCode,
      });
      return;
    }
    if (result.exitCode !== 0) {
      this.#finish(task, {
        status: 'failed',
        error: `${name}执行失败（exit ${result.exitCode}）：${(result.stderr.trim() || result.stdout.trim()).slice(0, 2000)}`,
        exitCode: result.exitCode,
      });
      return;
    }
    this.#finish(task, {
      status: 'success',
      result: (result.stdout.trim() || result.stderr.trim()).slice(0, 40_000),
      exitCode: result.exitCode,
    });
  }

  #finish(task: ColleagueTask, outcome: ColleagueFinishOutcome): void {
    const name = this.#spec.name;
    task.status = outcome.status;
    task.finishedAt = new Date().toISOString();
    if (outcome.result !== undefined) task.result = outcome.result;
    if (outcome.error !== undefined) task.error = outcome.error;
    if (outcome.exitCode !== undefined) task.exitCode = outcome.exitCode;
    void this.#persist();
    void this.#timeline?.addEvent({
      type: 'task',
      summary:
        outcome.status === 'success'
          ? `${name}任务完成（${task.id.slice(0, 8)}）：${task.task.slice(0, 80)}`
          : `${name}任务${outcome.status === 'timeout' ? '超时' : '失败'}（${task.id.slice(0, 8)}）：${task.task.slice(0, 80)}`,
      metadata: { colleague: name, colleagueTaskId: task.id, status: outcome.status },
    });
    void Promise.resolve()
      .then(() => this.#onFinish?.(task, outcome))
      .catch(() => {
        // 收尾副作用失败不阻断完成事件
      });
    this.#emit({
      type: 'done',
      taskId: task.id,
      status: outcome.status,
      colleague: name,
      ...(outcome.result ? { result: outcome.result } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }

  #emit(event: ColleagueTaskEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者出错不影响其他
      }
    }
  }

  async #persist(): Promise<void> {
    if (!this.#persistFile) return;
    const run = this.#persistChain.then(async () => {
      try {
        await mkdir(path.dirname(this.#persistFile!), { recursive: true });
        const records = [...this.#tasks.values()].slice(-MAX_TASKS);
        const tmp = `${this.#persistFile}.tmp`;
        await writeFile(tmp, JSON.stringify(records, null, 2), 'utf8');
        await rename(tmp, this.#persistFile!);
      } catch {
        // 持久化失败不致命：任务仍可运行/查询，只是重启后丢失记录
      }
    });
    this.#persistChain = run.catch(() => {});
    await run;
  }
}
