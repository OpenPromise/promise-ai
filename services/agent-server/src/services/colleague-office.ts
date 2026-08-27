import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionStore } from '@personal-ai/memory';
import type { Session } from '@personal-ai/types';
import type {
  ColleagueTask,
  ColleagueTaskEvent,
  ColleagueTaskRunner,
} from './colleague-task-runner.js';
import { XIAO_HEI_PROMPT } from './engineer-task-runner.js';
import { XIAO_YOU_PROMPT } from './ops-tools.js';
import { XIAO_MEI_PROMPT } from './designer-tools.js';
import { XIAO_ZHEN_PROMPT } from './qa-tools.js';
import { XIAO_ZHI_PROMPT } from './research-tools.js';

/** 五位同事短 id（小夜除外）。会话 metadata.colleagueId / 收件箱文件名用这个。 */
export type ColleagueId = 'xiaohei' | 'xiaoyou' | 'xiaomei' | 'xiaozhen' | 'xiaozhi';

export const COLLEAGUE_IDS: readonly ColleagueId[] = [
  'xiaohei',
  'xiaoyou',
  'xiaomei',
  'xiaozhen',
  'xiaozhi',
] as const;

export interface ColleagueRosterEntry {
  id: ColleagueId;
  name: string;
  prompt: string;
}

export const COLLEAGUE_ROSTER: readonly ColleagueRosterEntry[] = [
  { id: 'xiaohei', name: '小黑', prompt: XIAO_HEI_PROMPT },
  { id: 'xiaoyou', name: '小优', prompt: XIAO_YOU_PROMPT },
  { id: 'xiaomei', name: '小美', prompt: XIAO_MEI_PROMPT },
  { id: 'xiaozhen', name: '小真', prompt: XIAO_ZHEN_PROMPT },
  { id: 'xiaozhi', name: '小知', prompt: XIAO_ZHI_PROMPT },
];

export type MailStatus = 'queued' | 'running' | 'done' | 'failed';

export interface MailItem {
  id: string;
  from: 'xiaoye' | ColleagueId;
  to: ColleagueId;
  body: string;
  createdAt: string;
  status: MailStatus;
  taskId?: string;
  reply?: string;
}

export interface MailPreview {
  id: string;
  subject: string;
  status: MailStatus;
  createdAt: string;
  taskId?: string;
}

export type ColleagueRunners = Record<ColleagueId, ColleagueTaskRunner>;

/** ConversationService.runChat 的最小端口：测试可注入假 generator。 */
export interface ColleagueConversation {
  runChat(input: {
    sessionId: string;
    userMessage: string;
    headless?: boolean;
    toolAllowlist?: string[];
    toolBudget?: number;
    signal?: AbortSignal;
    requestId?: string;
  }): AsyncIterable<{ type: string; payload?: unknown }>;
}

export interface ColleagueOfficeOptions {
  store: SessionStore;
  runners: ColleagueRunners;
  /** 收件箱 JSON 目录，默认 ./data/mailboxes */
  mailboxDir?: string;
}

const RESULT_CAP = 8_000;
const MAX_MAIL = 100;
const TOOL_BUDGET = 12;
const DEFAULT_TIMEOUT_MINUTES = 15;

/** 禁止再派单 / 查同事状态，避免同事会话递归调用 *.delegate。 */
export const BLOCKED_COLLEAGUE_TOOLS: readonly string[] = [
  'engineer.delegate',
  'ops.delegate',
  'designer.delegate',
  'qa.delegate',
  'research.delegate',
  'engineer.status',
  'ops.status',
  'designer.status',
  'qa.status',
  'research.status',
];

export const SHARED_COLLEAGUE_TOOLS: readonly string[] = [
  'filesystem.search',
  'memory.list',
  'memory.remember',
];

export const COLLEAGUE_EXTRA_TOOLS: Record<ColleagueId, readonly string[]> = {
  xiaohei: [
    'coding.run',
    'github.search_repos',
    'github.issues',
    'github.create_issue',
    'github.comment',
    'server.shell',
  ],
  xiaoyou: ['server.shell', 'system.status'],
  xiaomei: ['filesystem.search', 'coding.run'],
  xiaozhen: ['coding.run', 'filesystem.search', 'server.shell'],
  xiaozhi: ['web.search', 'web.fetch', 'github.search_repos'],
};

/**
 * 同事会话工具白名单：共享检索/记忆 + 岗位工具；永远不含 *.delegate 与同事 *.status。
 * system.status 是巡检工具，给小优保留。
 */
export function colleagueToolAllowlist(colleagueId: ColleagueId): string[] {
  const blocked = new Set(BLOCKED_COLLEAGUE_TOOLS);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of [...SHARED_COLLEAGUE_TOOLS, ...COLLEAGUE_EXTRA_TOOLS[colleagueId]]) {
    if (blocked.has(name) || name.endsWith('.delegate')) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function colleagueName(id: ColleagueId): string {
  return COLLEAGUE_ROSTER.find((entry) => entry.id === id)?.name ?? id;
}

function truncate(text: string, cap = RESULT_CAP): string {
  const trimmed = text.trim();
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, cap)}\n…(truncated)`;
}

function mailSubject(item: MailItem): string {
  const line = item.body.trim().split(/\r?\n/).find((row) => row.trim().length > 0) ?? '';
  return line.slice(0, 80);
}

function isColleagueId(value: unknown): value is ColleagueId {
  return typeof value === 'string' && (COLLEAGUE_IDS as readonly string[]).includes(value);
}

function sessionColleagueId(session: Session): ColleagueId | undefined {
  const meta = session.metadata;
  if (!meta || meta.role !== 'colleague') return undefined;
  return isColleagueId(meta.colleagueId) ? meta.colleagueId : undefined;
}

function clampTimeoutMinutes(value: number | undefined): number {
  return Math.min(Math.max(1, Math.floor(value ?? DEFAULT_TIMEOUT_MINUTES)), 60);
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {};
  return payload as Record<string, unknown>;
}

function toolCallNames(payload: unknown): string[] {
  const calls = payloadRecord(payload).toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls
    .map((call) => {
      if (!call || typeof call !== 'object') return '';
      const name = (call as { name?: unknown }).name;
      return typeof name === 'string' ? name : '';
    })
    .filter((name) => name.length > 0);
}

/**
 * 同事办公室：五位同事各有一条持久 Postgres 会话 + 文件收件箱。
 * 小夜的 *.delegate 写信入收件箱，再在该同事自己的会话上跑 ConversationService.runChat
 * （headless + 工具白名单）。无 conversation 时回退 ColleagueTaskRunner（dsh）。
 * 不另起 Node 进程 / 容器。
 */
export class ColleagueOffice {
  readonly #store: SessionStore;
  readonly #runners: ColleagueRunners;
  readonly #mailboxDir: string;
  readonly #sessionIds = new Map<ColleagueId, string>();
  readonly #mail = new Map<ColleagueId, MailItem[]>();
  readonly #tasks = new Map<string, ColleagueTask>();
  readonly #pendingDone = new Map<string, ColleagueTaskEvent>();
  readonly #unsubs: Array<() => void> = [];
  readonly #listeners = new Set<(event: ColleagueTaskEvent) => void>();
  #conversation?: ColleagueConversation;
  #persistChain: Promise<void> = Promise.resolve();
  #attached = false;

  constructor(options: ColleagueOfficeOptions) {
    this.#store = options.store;
    this.#runners = options.runners;
    this.#mailboxDir = options.mailboxDir ?? path.resolve('./data/mailboxes');
  }

  /** 生产在 ConversationService 建好后注入；测试可传假 runChat。 */
  attachConversation(conversation: ColleagueConversation): void {
    this.#conversation = conversation;
  }

  onEvent(listener: (event: ColleagueTaskEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getSessionId(colleagueId: ColleagueId): string | undefined {
    return this.#sessionIds.get(colleagueId);
  }

  getTask(id: string): ColleagueTask | undefined {
    return this.#tasks.get(id);
  }

  listTasks(limit = 10): ColleagueTask[] {
    return [...this.#tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.floor(limit)));
  }

  /**
   * 启动时为五位同事确保各有一条 tagged session：已有则复用并刷新过期 systemPrompt，
   * 没有则 createSession。对微信 peer 会话不动。幂等：二次启动返回同一批 session id。
   */
  async ensureSessions(): Promise<Map<ColleagueId, string>> {
    const existing = await this.#store.listSessions();
    const byColleague = new Map<ColleagueId, Session>();
    for (const session of existing) {
      const id = sessionColleagueId(session);
      if (!id) continue;
      const prev = byColleague.get(id);
      if (!prev || session.createdAt.localeCompare(prev.createdAt) < 0) {
        byColleague.set(id, session);
      }
    }

    for (const entry of COLLEAGUE_ROSTER) {
      const found = byColleague.get(entry.id);
      if (found) {
        if (!found.systemPrompt || found.systemPrompt !== entry.prompt) {
          await this.#store.updateSession(found.id, { systemPrompt: entry.prompt });
        }
        this.#sessionIds.set(entry.id, found.id);
        continue;
      }
      const created = await this.#store.createSession({
        systemPrompt: entry.prompt,
        metadata: { role: 'colleague', colleagueId: entry.id, name: entry.name },
      });
      this.#sessionIds.set(entry.id, created.id);
    }
    return new Map(this.#sessionIds);
  }

  /** 读盘收件箱、订阅 runner 完成事件、把重启后残留的 running 信对账成 done/failed。 */
  async hydrate(): Promise<void> {
    await mkdir(this.#mailboxDir, { recursive: true });
    for (const id of COLLEAGUE_IDS) {
      this.#mail.set(id, await this.#loadMailbox(id));
    }
    this.#attach();
    await this.#reconcile();
  }

  /**
   * 小夜派单：写信入收件箱。有 conversation 时在同事自己的会话上 headless runChat；
   * 否则回退 runner.delegate（异步 dsh / SSE）。
   */
  async delegate(
    colleagueId: string,
    task: string,
    options: { directory?: string; timeoutMinutes?: number } = {},
  ): Promise<ColleagueTask> {
    if (!isColleagueId(colleagueId)) {
      throw new Error(`unknown colleague: ${colleagueId}`);
    }
    const body = task.trim();
    const mail: MailItem = {
      id: randomUUID(),
      from: 'xiaoye',
      to: colleagueId,
      body,
      createdAt: new Date().toISOString(),
      status: 'queued',
    };
    this.#pushMail(colleagueId, mail);
    await this.#persist(colleagueId);

    if (this.#conversation) {
      return this.#delegateViaConversation(colleagueId, mail, body, options);
    }
    return this.#delegateViaRunner(colleagueId, mail, body, options);
  }

  /** 最近几封信的主题/状态，供 *.status 让小夜说「小黑收件箱还有一封在跑」。 */
  recentMail(colleagueId: string, limit = 3): MailPreview[] {
    if (!isColleagueId(colleagueId)) return [];
    const items = this.#mail.get(colleagueId) ?? [];
    return [...items]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.floor(limit)))
      .map((item) => ({
        id: item.id,
        subject: mailSubject(item),
        status: item.status,
        createdAt: item.createdAt,
        ...(item.taskId ? { taskId: item.taskId } : {}),
      }));
  }

  listMailbox(colleagueId: ColleagueId): MailItem[] {
    return [...(this.#mail.get(colleagueId) ?? [])];
  }

  async #delegateViaConversation(
    colleagueId: ColleagueId,
    mail: MailItem,
    body: string,
    options: { directory?: string; timeoutMinutes?: number },
  ): Promise<ColleagueTask> {
    const name = colleagueName(colleagueId);
    const timeoutMinutes = clampTimeoutMinutes(options.timeoutMinutes);
    const directory = path.resolve(options.directory ?? '/app');
    const taskId = randomUUID();
    mail.taskId = taskId;
    mail.status = 'running';
    await this.#persist(colleagueId);

    const record: ColleagueTask = {
      id: taskId,
      colleague: name,
      task: body,
      directory,
      status: 'running',
      createdAt: mail.createdAt,
      startedAt: new Date().toISOString(),
      output: '',
    };
    this.#tasks.set(taskId, record);

    const startedText = this.#runners[colleagueId].spec.startedText;
    this.#emit({
      type: 'started',
      taskId,
      status: 'running',
      colleague: name,
      text: startedText,
    });

    void this.#runLoop(colleagueId, mail, record, timeoutMinutes);
    return record;
  }

  async #delegateViaRunner(
    colleagueId: ColleagueId,
    mail: MailItem,
    body: string,
    options: { directory?: string; timeoutMinutes?: number },
  ): Promise<ColleagueTask> {
    const runner = this.#runners[colleagueId];
    const sessionId = this.#sessionIds.get(colleagueId);
    if (sessionId) {
      await this.#store.addMessage(sessionId, { role: 'user', content: body });
    }

    try {
      const record = await runner.delegate(body, options);
      const current = this.#findMail(colleagueId, mail.id);
      if (current) {
        current.taskId = record.id;
        if (current.status === 'queued') current.status = 'running';
      }
      await this.#persist(colleagueId);
      const pending = this.#pendingDone.get(record.id);
      if (pending) {
        this.#pendingDone.delete(record.id);
        await this.#applyDone(colleagueId, pending);
      }
      return record;
    } catch (error) {
      const current = this.#findMail(colleagueId, mail.id);
      if (current && current.status === 'queued') {
        current.status = 'failed';
        current.reply = truncate(
          `启动失败：${error instanceof Error ? error.message : String(error)}`,
        );
        await this.#persist(colleagueId);
      }
      throw error;
    }
  }

  async #runLoop(
    colleagueId: ColleagueId,
    mail: MailItem,
    record: ColleagueTask,
    timeoutMinutes: number,
  ): Promise<void> {
    const conversation = this.#conversation;
    const name = record.colleague ?? colleagueName(colleagueId);
    if (!conversation) {
      await this.#settle(colleagueId, mail, record, {
        ok: false,
        text: '同事会话未接入',
        skipSession: false,
      });
      return;
    }
    const sessionId = this.#sessionIds.get(colleagueId);
    if (!sessionId) {
      await this.#settle(colleagueId, mail, record, {
        ok: false,
        text: '同事会话不存在',
        skipSession: false,
      });
      return;
    }

    const userMessage = `【小夜来信】\n${mail.body}`;
    const toolAllowlist = colleagueToolAllowlist(colleagueId);
    let finished = false;
    try {
      const iterator = conversation.runChat({
        sessionId,
        userMessage,
        headless: true,
        toolAllowlist,
        toolBudget: TOOL_BUDGET,
        signal: AbortSignal.timeout(timeoutMinutes * 60 * 1000),
        requestId: record.id,
      });
      for await (const env of iterator) {
        if (finished) continue;
        if (env.type === 'agent.tool_call') {
          for (const toolName of toolCallNames(env.payload)) {
            record.progress = toolName;
            this.#emit({
              type: 'progress',
              taskId: record.id,
              status: 'running',
              colleague: name,
              text: toolName,
            });
          }
          continue;
        }
        if (env.type === 'chat.done') {
          const text = String(payloadRecord(env.payload).text ?? '');
          await this.#settle(colleagueId, mail, record, {
            ok: true,
            text,
            skipSession: true,
          });
          finished = true;
          continue;
        }
        if (env.type === 'chat.error') {
          const error = String(payloadRecord(env.payload).error ?? '对话失败');
          await this.#settle(colleagueId, mail, record, {
            ok: false,
            text: error,
            skipSession: true,
          });
          finished = true;
        }
      }
      if (!finished) {
        await this.#settle(colleagueId, mail, record, {
          ok: false,
          text: '会话结束但未返回结果',
          skipSession: false,
        });
      }
    } catch (error) {
      if (finished) return;
      await this.#settle(colleagueId, mail, record, {
        ok: false,
        text: error instanceof Error ? error.message : String(error),
        skipSession: false,
      });
    }
  }

  async #settle(
    colleagueId: ColleagueId,
    mail: MailItem,
    record: ColleagueTask,
    outcome: { ok: boolean; text: string; skipSession: boolean },
  ): Promise<void> {
    const name = record.colleague ?? colleagueName(colleagueId);
    const reply = truncate(outcome.text);
    await this.#finishMail(
      colleagueId,
      mail,
      { status: outcome.ok ? 'done' : 'failed', reply },
      { skipSession: outcome.skipSession },
    );
    await this.#persist(colleagueId);
    record.status = outcome.ok ? 'success' : 'failed';
    record.finishedAt = new Date().toISOString();
    if (outcome.ok) record.result = reply;
    else record.error = reply || '任务失败';
    this.#emit({
      type: 'done',
      taskId: record.id,
      status: record.status,
      colleague: name,
      ...(outcome.ok && reply ? { result: reply } : {}),
      ...(!outcome.ok ? { error: reply || '任务失败' } : {}),
    });
  }

  #attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    for (const id of COLLEAGUE_IDS) {
      const unsub = this.#runners[id].onEvent((event) => {
        if (event.type !== 'done') return;
        void this.#applyDone(id, event).catch(() => {
          // 收件箱收尾失败不阻断 SSE
        });
      });
      this.#unsubs.push(unsub);
    }
  }

  async #reconcile(): Promise<void> {
    for (const id of COLLEAGUE_IDS) {
      let changed = false;
      for (const mail of this.#mail.get(id) ?? []) {
        if ((mail.status !== 'queued' && mail.status !== 'running') || !mail.taskId) continue;
        const task = this.#runners[id].get(mail.taskId);
        if (task?.status === 'running') continue;
        if (task) {
          await this.#finishMail(id, mail, {
            status: task.status === 'success' ? 'done' : 'failed',
            reply: truncate(task.result ?? task.error ?? ''),
          });
          changed = true;
          continue;
        }
        // 会话路径任务在进程内，重启后 runner 没有记录：残留 queued/running 标失败
        await this.#finishMail(id, mail, {
          status: 'failed',
          reply: '进程重启，任务中断',
        });
        changed = true;
      }
      if (changed) await this.#persist(id);
    }
  }

  async #applyDone(colleagueId: ColleagueId, event: ColleagueTaskEvent): Promise<void> {
    const mail =
      this.#findByTaskId(colleagueId, event.taskId) ?? this.#latestOpenMail(colleagueId);
    if (!mail) {
      this.#pendingDone.set(event.taskId, event);
      return;
    }
    if (!mail.taskId) mail.taskId = event.taskId;
    if (mail.status === 'done' || mail.status === 'failed') return;
    const failed = event.status !== 'success';
    await this.#finishMail(colleagueId, mail, {
      status: failed ? 'failed' : 'done',
      reply: truncate(event.result ?? event.error ?? ''),
    });
    await this.#persist(colleagueId);
  }

  async #finishMail(
    colleagueId: ColleagueId,
    mail: MailItem,
    outcome: { status: 'done' | 'failed'; reply: string },
    options: { skipSession?: boolean } = {},
  ): Promise<void> {
    mail.status = outcome.status;
    if (outcome.reply) mail.reply = outcome.reply;
    if (options.skipSession) return;
    const sessionId = this.#sessionIds.get(colleagueId);
    if (sessionId && outcome.reply) {
      await this.#store.addMessage(sessionId, {
        role: 'assistant',
        content: outcome.reply,
      });
    }
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

  #pushMail(colleagueId: ColleagueId, mail: MailItem): void {
    const items = this.#mail.get(colleagueId) ?? [];
    items.push(mail);
    if (items.length > MAX_MAIL) {
      const overflow = items.length - MAX_MAIL;
      items.splice(0, overflow);
    }
    this.#mail.set(colleagueId, items);
  }

  #findMail(colleagueId: ColleagueId, mailId: string): MailItem | undefined {
    return (this.#mail.get(colleagueId) ?? []).find((item) => item.id === mailId);
  }

  #findByTaskId(colleagueId: ColleagueId, taskId: string): MailItem | undefined {
    return (this.#mail.get(colleagueId) ?? []).find((item) => item.taskId === taskId);
  }

  #latestOpenMail(colleagueId: ColleagueId): MailItem | undefined {
    const items = this.#mail.get(colleagueId) ?? [];
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item && (item.status === 'queued' || item.status === 'running') && !item.taskId) {
        return item;
      }
    }
    return undefined;
  }

  #mailboxPath(colleagueId: ColleagueId): string {
    return path.join(this.#mailboxDir, `${colleagueId}.json`);
  }

  async #loadMailbox(colleagueId: ColleagueId): Promise<MailItem[]> {
    try {
      const raw = await readFile(this.#mailboxPath(colleagueId), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is MailItem => {
        if (!item || typeof item !== 'object') return false;
        const row = item as MailItem;
        return typeof row.id === 'string' && typeof row.body === 'string' && typeof row.status === 'string';
      });
    } catch {
      return [];
    }
  }

  async #persist(colleagueId: ColleagueId): Promise<void> {
    const run = this.#persistChain.then(async () => {
      try {
        await mkdir(this.#mailboxDir, { recursive: true });
        const file = this.#mailboxPath(colleagueId);
        const records = this.#mail.get(colleagueId) ?? [];
        const tmp = `${file}.tmp`;
        await writeFile(tmp, JSON.stringify(records, null, 2), 'utf8');
        await rename(tmp, file);
      } catch {
        // 收件箱落盘失败不致命：内存仍可查，重启后丢失未写入的信
      }
    });
    this.#persistChain = run.catch(() => {});
    await run;
  }
}
