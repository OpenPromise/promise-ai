import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SessionNotFoundError,
  type SessionStore,
  type TaskStore,
  type TimelineStore,
} from '@personal-ai/memory';
import type { ConversationService } from './conversation.js';
import type { TaskRunEvent } from './task-service.js';
import {
  COLLEAGUE_IDS,
  COLLEAGUE_ROSTER,
  type ColleagueId,
  type ColleagueOffice,
  type MailItem,
} from './colleague-office.js';

/** 默认心跳间隔：30 分钟（OpenClaw DEFAULT_HEARTBEAT_EVERY = 30m）。 */
export const DEFAULT_HEARTBEAT_EVERY_MS = 30 * 60_000;
/** 心跳工具预算：便宜短回合。 */
export const HEARTBEAT_TOOL_BUDGET = 5;
/** running 超过该时长视为卡住。 */
export const STALE_RUNNING_MS = 45 * 60_000;
/** queued 超过该时长视为积压。 */
export const STALE_QUEUED_MS = 20 * 60_000;
/** 近期失败窗口。 */
export const RECENT_FAILED_MS = 2 * 60 * 60_000;
/** 单次心跳总超时。 */
export const HEARTBEAT_RUN_TIMEOUT_MS = 2 * 60_000;

export const HEARTBEAT_TOOL_ALLOWLIST: readonly string[] = [
  'system.status',
  'time.get',
  'timeline.list',
  'task.list',
  'engineer.status',
  'ops.status',
  'designer.status',
  'qa.status',
  'research.status',
];

export const DIGEST_TASK_NAMES = {
  morning: 'morning-digest',
  evening: 'evening-digest',
} as const;

export interface MailboxSignal {
  colleagueId: ColleagueId;
  colleagueName: string;
  queued: number;
  running: number;
  failedRecent: number;
  stale: Array<{ id: string; status: string; ageMinutes: number; subject: string }>;
}

export interface HeartbeatSignals {
  mailboxes: MailboxSignal[];
  recentTaskErrors: Array<{ name: string; error: string; finishedAt: string }>;
  needsAttention: boolean;
  summary: string;
}

export interface HeartbeatServiceDeps {
  conversation: ConversationService;
  sessions: SessionStore;
  tasks: TaskStore;
  colleagueOffice: ColleagueOffice;
  systemPrompt: () => Promise<string>;
  /** 读 persona/heartbeat.md；缺省时用内置短提示。 */
  heartbeatPrompt?: () => Promise<string>;
  timeline?: TimelineStore;
  everyMs?: number;
  /** 用户微信回合进行中时跳过（忙守卫）。 */
  isBusy?: () => boolean;
  toolBudget?: number;
  runTimeoutMs?: number;
  /** 测试注入时钟。 */
  now?: () => Date;
  enabled?: boolean;
}

export function colleagueDisplayName(id: ColleagueId): string {
  return COLLEAGUE_ROSTER.find((entry) => entry.id === id)?.name ?? id;
}

export function mailSubject(item: MailItem): string {
  const firstLine = item.body.split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
  return firstLine.slice(0, 80) || item.id.slice(0, 8);
}

/** 纯函数：从收件箱与近期任务失败汇总便宜信号。 */
export function collectHeartbeatSignals(input: {
  mailboxes: Record<ColleagueId, MailItem[]>;
  recentTaskErrors?: Array<{ name: string; error: string; finishedAt: string }>;
  now?: Date;
  staleRunningMs?: number;
  staleQueuedMs?: number;
  recentFailedMs?: number;
}): HeartbeatSignals {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const staleRunningMs = input.staleRunningMs ?? STALE_RUNNING_MS;
  const staleQueuedMs = input.staleQueuedMs ?? STALE_QUEUED_MS;
  const recentFailedMs = input.recentFailedMs ?? RECENT_FAILED_MS;
  const mailboxes: MailboxSignal[] = [];

  for (const id of COLLEAGUE_IDS) {
    const items = input.mailboxes[id] ?? [];
    const queued = items.filter((item) => item.status === 'queued').length;
    const running = items.filter((item) => item.status === 'running').length;
    const failedRecent = items.filter((item) => {
      if (item.status !== 'failed') return false;
      const age = nowMs - Date.parse(item.createdAt);
      return Number.isFinite(age) && age <= recentFailedMs;
    }).length;
    const stale = items
      .filter((item) => item.status === 'queued' || item.status === 'running')
      .map((item) => {
        const age = nowMs - Date.parse(item.createdAt);
        const limit = item.status === 'running' ? staleRunningMs : staleQueuedMs;
        if (!Number.isFinite(age) || age < limit) return undefined;
        return {
          id: item.id,
          status: item.status,
          ageMinutes: Math.round(age / 60_000),
          subject: mailSubject(item),
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    mailboxes.push({
      colleagueId: id,
      colleagueName: colleagueDisplayName(id),
      queued,
      running,
      failedRecent,
      stale,
    });
  }

  const recentTaskErrors = input.recentTaskErrors ?? [];
  const attentionParts: string[] = [];
  for (const box of mailboxes) {
    if (box.stale.length > 0) {
      attentionParts.push(
        `${box.colleagueName} 卡住 ${box.stale.length} 封（${box.stale
          .map((s) => `${s.status}/${s.ageMinutes}m`)
          .join('、')}）`,
      );
    }
    if (box.failedRecent > 0) {
      attentionParts.push(`${box.colleagueName} 近 2h 失败 ${box.failedRecent} 封`);
    }
    if (box.queued >= 3) {
      attentionParts.push(`${box.colleagueName} 积压 queued=${box.queued}`);
    }
  }
  for (const err of recentTaskErrors) {
    attentionParts.push(`定时任务失败「${err.name}」：${err.error.slice(0, 80)}`);
  }

  const needsAttention = attentionParts.length > 0;
  const summary = needsAttention
    ? attentionParts.join('；')
    : '收件箱与近期定时任务未见异常';

  return { mailboxes, recentTaskErrors, needsAttention, summary };
}

export function formatSignalsForPrompt(signals: HeartbeatSignals): string {
  const lines: string[] = [`信号摘要：${signals.summary}`];
  for (const box of signals.mailboxes) {
    if (box.queued === 0 && box.running === 0 && box.failedRecent === 0 && box.stale.length === 0) {
      continue;
    }
    lines.push(
      `- ${box.colleagueName}：queued=${box.queued} running=${box.running} failedRecent=${box.failedRecent}` +
        (box.stale.length
          ? ` stale=[${box.stale.map((s) => `${s.subject}(${s.status},${s.ageMinutes}m)`).join(' | ')}]`
          : ''),
    );
  }
  for (const err of signals.recentTaskErrors) {
    lines.push(`- 任务失败 ${err.name}@${err.finishedAt}：${err.error.slice(0, 120)}`);
  }
  return lines.join('\n');
}

export function isSilentHeartbeatOutput(output: string): boolean {
  const text = output.trim().toUpperCase();
  if (!text) return true;
  return (
    text === 'HEARTBEAT_OK' ||
    text === 'NO_REPLY' ||
    text.includes('HEARTBEAT_OK') ||
    text.includes('NO_REPLY')
  );
}

const FALLBACK_HEARTBEAT_PROMPT =
  '定时巡检：无事回复 HEARTBEAT_OK；有异常用一段合并摘要说明。不要委派，不要寒暄。';

export async function loadHeartbeatPrompt(personaDir: string): Promise<string> {
  try {
    const content = await readFile(path.join(personaDir, 'heartbeat.md'), 'utf8');
    const trimmed = content.trim();
    return trimmed || FALLBACK_HEARTBEAT_PROMPT;
  } catch {
    return FALLBACK_HEARTBEAT_PROMPT;
  }
}

export const MORNING_DIGEST_ACTION =
  '【早晚摘要·早】请按 persona/heartbeat.md 做一次早间摘要：' +
  '看同事收件箱/卡住任务/系统健康/昨夜失败。无事只回 HEARTBEAT_OK；有事给一段合并 digest。';

export const EVENING_DIGEST_ACTION =
  '【早晚摘要·晚】请按 persona/heartbeat.md 做一次晚间摘要：' +
  '概括今日同事进展、未完成/卡住项、异常。无事只回 HEARTBEAT_OK；有事给一段合并 digest。';

/**
 * 幂等种下早晚摘要定时任务（09:00 / 21:00，宿主机 Asia/Shanghai）。
 * 已存在同名任务则跳过，不覆盖用户改过的 schedule/action。
 */
export async function ensureDigestTasks(deps: {
  tasks: TaskStore;
  createTaskSession: (action: string) => Promise<string>;
}): Promise<{ created: string[]; skipped: string[] }> {
  const existing = await deps.tasks.listTasks();
  const byName = new Map(existing.map((task) => [task.name, task]));
  const created: string[] = [];
  const skipped: string[] = [];

  const specs = [
    {
      name: DIGEST_TASK_NAMES.morning,
      schedule: '0 9 * * *',
      action: MORNING_DIGEST_ACTION,
    },
    {
      name: DIGEST_TASK_NAMES.evening,
      schedule: '0 21 * * *',
      action: EVENING_DIGEST_ACTION,
    },
  ] as const;

  for (const spec of specs) {
    if (byName.has(spec.name)) {
      skipped.push(spec.name);
      continue;
    }
    const sessionId = await deps.createTaskSession(spec.action);
    await deps.tasks.createTask({
      name: spec.name,
      schedule: spec.schedule,
      action: spec.action,
      sessionId,
      tools: [...HEARTBEAT_TOOL_ALLOWLIST],
    });
    created.push(spec.name);
  }
  return { created, skipped };
}

/**
 * 常驻心跳：定期轻量巡检收件箱/卡住委派/健康信号。
 * 无事 → HEARTBEAT_OK（event-pusher 静默）；有事 → 一段合并 digest 经 task.run 推微信。
 */
export class HeartbeatService {
  readonly #conversation: ConversationService;
  readonly #sessions: SessionStore;
  readonly #tasks: TaskStore;
  readonly #office: ColleagueOffice;
  readonly #systemPrompt: () => Promise<string>;
  readonly #heartbeatPrompt: () => Promise<string>;
  readonly #timeline?: TimelineStore;
  readonly #everyMs: number;
  readonly #isBusy?: () => boolean;
  readonly #toolBudget: number;
  readonly #runTimeoutMs: number;
  readonly #now: () => Date;
  readonly #enabled: boolean;
  readonly #listeners = new Set<(event: TaskRunEvent) => void>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #sessionId: string | undefined;

  constructor(deps: HeartbeatServiceDeps) {
    this.#conversation = deps.conversation;
    this.#sessions = deps.sessions;
    this.#tasks = deps.tasks;
    this.#office = deps.colleagueOffice;
    this.#systemPrompt = deps.systemPrompt;
    this.#heartbeatPrompt = deps.heartbeatPrompt ?? (async () => FALLBACK_HEARTBEAT_PROMPT);
    this.#timeline = deps.timeline;
    this.#everyMs = Math.max(60_000, Math.floor(deps.everyMs ?? DEFAULT_HEARTBEAT_EVERY_MS));
    this.#isBusy = deps.isBusy;
    this.#toolBudget = Math.max(1, Math.floor(deps.toolBudget ?? HEARTBEAT_TOOL_BUDGET));
    this.#runTimeoutMs = Math.max(10_000, Math.floor(deps.runTimeoutMs ?? HEARTBEAT_RUN_TIMEOUT_MS));
    this.#now = deps.now ?? (() => new Date());
    this.#enabled = deps.enabled ?? true;
  }

  start(): void {
    if (!this.#enabled || this.#timer) return;
    this.#timer = setInterval(() => void this.checkNow(), this.#everyMs);
    this.#timer.unref?.();
    // 启动后稍晚跑一次，避开 boot 洪峰（约 1 分钟）。
    const boot = setTimeout(() => void this.checkNow(), Math.min(60_000, this.#everyMs));
    boot.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  onRun(listener: (event: TaskRunEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 公开便于测试确定性触发。 */
  async checkNow(): Promise<void> {
    if (!this.#enabled || this.#running) return;
    if (this.#isBusy?.()) {
      console.log('[heartbeat] skip: user session busy');
      return;
    }
    this.#running = true;
    const startedAt = this.#now().toISOString();
    try {
      const signals = await this.#collectSignals();
      // 便宜快路径：信号干净则不跑 LLM，直接静默。
      if (!signals.needsAttention) {
        this.#emitOk(startedAt, 'HEARTBEAT_OK');
        return;
      }
      const output = await this.#runAgentTurn(signals);
      const finishedAt = this.#now().toISOString();
      const silent = isSilentHeartbeatOutput(output);
      const normalized = silent ? 'HEARTBEAT_OK' : output.trim().slice(0, 800);
      await this.#timeline?.addEvent({
        type: 'system',
        summary: silent
          ? '心跳巡检：无异常'
          : `心跳摘要：${normalized.slice(0, 100)}`,
      });
      this.#emit({
        taskId: 'heartbeat',
        taskName: 'heartbeat',
        schedule: `every ${Math.round(this.#everyMs / 60_000)}m`,
        action: 'heartbeat',
        status: 'success',
        output: normalized,
        startedAt,
        finishedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[heartbeat] failed: ${message}`);
      this.#emit({
        taskId: 'heartbeat',
        taskName: 'heartbeat',
        schedule: `every ${Math.round(this.#everyMs / 60_000)}m`,
        action: 'heartbeat',
        status: 'error',
        error: message.slice(0, 300),
        startedAt,
        finishedAt: this.#now().toISOString(),
      });
    } finally {
      this.#running = false;
    }
  }

  async #collectSignals(): Promise<HeartbeatSignals> {
    const mailboxes = {} as Record<ColleagueId, MailItem[]>;
    for (const id of COLLEAGUE_IDS) {
      mailboxes[id] = this.#office.listMailbox(id);
    }
    const runs = await this.#tasks.listRuns(undefined, 20);
    const cutoff = this.#now().getTime() - RECENT_FAILED_MS;
    const recentFailedRuns = runs.filter(
      (run) => run.status === 'error' && Date.parse(run.finishedAt) >= cutoff,
    );
    const taskList = await this.#tasks.listTasks();
    const nameById = new Map(taskList.map((task) => [task.id, task.name]));
    const recentTaskErrors = recentFailedRuns.slice(0, 5).map((run) => ({
      name: nameById.get(run.taskId) ?? run.taskId.slice(0, 8),
      error: (run.error ?? 'unknown').slice(0, 200),
      finishedAt: run.finishedAt,
    }));
    return collectHeartbeatSignals({
      mailboxes,
      recentTaskErrors,
      now: this.#now(),
    });
  }

  async #resolveSession(): Promise<string> {
    if (this.#sessionId) {
      try {
        await this.#sessions.getSession(this.#sessionId);
        return this.#sessionId;
      } catch (error) {
        if (!(error instanceof SessionNotFoundError)) throw error;
        this.#sessionId = undefined;
      }
    }
    const prompt = await this.#systemPrompt();
    const heartbeat = await this.#heartbeatPrompt();
    const session = await this.#sessions.createSession({
      systemPrompt: `${prompt}\n\n## Heartbeat 协议\n${heartbeat}`,
      metadata: { kind: 'heartbeat' },
    });
    this.#sessionId = session.id;
    return session.id;
  }

  async #runAgentTurn(signals: HeartbeatSignals): Promise<string> {
    const sessionId = await this.#resolveSession();
    const heartbeat = await this.#heartbeatPrompt();
    const userMessage =
      `【心跳巡检】\n${formatSignalsForPrompt(signals)}\n\n` +
      `${heartbeat}\n\n` +
      '请根据以上信号判断：无事只回 HEARTBEAT_OK；有事给一段合并摘要。' +
      '可用 system.status / *.status / timeline.list / task.list；不要 delegate。';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#runTimeoutMs);
    timer.unref?.();
    try {
      let output = '';
      for await (const envelope of this.#conversation.runChat({
        sessionId,
        userMessage,
        headless: true,
        toolAllowlist: [...HEARTBEAT_TOOL_ALLOWLIST],
        toolBudget: this.#toolBudget,
        signal: controller.signal,
      })) {
        if (envelope.type === 'chat.token') {
          output += (envelope.payload as { delta?: string }).delta ?? '';
        } else if (envelope.type === 'chat.done') {
          const text = (envelope.payload as { text?: string }).text;
          if (text) output = text;
        }
      }
      if (controller.signal.aborted) {
        throw new Error(`心跳超过 ${Math.round(this.#runTimeoutMs / 1000)} 秒，已终止`);
      }
      return output;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  #emitOk(startedAt: string, output: string): void {
    this.#emit({
      taskId: 'heartbeat',
      taskName: 'heartbeat',
      schedule: `every ${Math.round(this.#everyMs / 60_000)}m`,
      action: 'heartbeat',
      status: 'success',
      output,
      startedAt,
      finishedAt: this.#now().toISOString(),
    });
  }

  #emit(event: TaskRunEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者出错不影响其他
      }
    }
  }
}
