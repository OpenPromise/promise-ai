import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { SessionStore } from '@personal-ai/memory';
import type { Session } from '@personal-ai/types';
import { withExclusiveFileLock } from './file-lock.js';
import {
  colleagueForkEnabled,
  colleagueForkStaggerMs,
  forkColleagueWorker,
} from './colleague-fork.js';
import { publishColleagueEvent, type ColleagueChildEvent } from './colleague-internal.js';
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
import { containsDsmlToolXml, stripDsmlToolXml } from './conversation.js';
import {
  DEFAULT_GIT_REPO_DIR,
  deliverMailChanges,
  shouldAutoCommitMail,
  snapshotGitStatus,
  type GitDeliveryResult,
  type GitStatusSnapshot,
} from './git-delivery.js';

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
  /** 小夜微信会话 id（派单方）。验收 wrap-up 必须跑在这个会话上，不能是同事会话。 */
  hubSessionId?: string;
  /** 本封信的同事链路：parent.chain + from（from 为同事时）。用于 cycle / 跳数。 */
  chain?: ColleagueId[];
  /** 由 mail.ask 触发：被问方不允许再 mail.ask / mail.send。 */
  nested?: boolean;
}

/** 派单 / 互问 / 转交共用选项。hubSessionId 只来自父信，不是调用方同事 session。 */
export interface ColleagueDispatchOptions {
  directory?: string;
  timeoutMinutes?: number;
  hubSessionId?: string;
  from?: 'xiaoye' | ColleagueId;
  wait?: boolean;
  nested?: boolean;
  chain?: ColleagueId[];
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
  /** 该会话是否已有 in-flight / 排队的 runChat。冲突时跳过 LLM 验收，避免卡住微信 chatOnce。 */
  isSessionBusy?(sessionId: string): boolean;
}

/** inprocess=测试默认；parent=生产主进程 fork；child=同事信箱子进程。 */
export type ColleagueIsolation = 'inprocess' | 'parent' | 'child';

export interface ColleagueOfficeOptions {
  store: SessionStore;
  runners: ColleagueRunners;
  /** 收件箱 JSON 目录，默认 ./data/mailboxes */
  mailboxDir?: string;
  /** 自动提交对照的仓库根。默认 /app（compose bind-mount）。测试传 null 禁用，勿碰直播 checkout。 */
  gitRepoDir?: string | null;
  /**
   * 隔离模式。缺省 inprocess（vitest / 显式关 fork）。
   * 生产主进程传 parent；colleague-worker 传 child。
   */
  isolation?: ColleagueIsolation;
  /** child 模式只跑这一位的信箱循环。 */
  workerColleagueId?: ColleagueId;
  /** 测试注入 fork；生产默认 forkColleagueWorker。 */
  forkWorker?: (id: ColleagueId) => ChildProcess;
  /**
   * 相邻 fork 间隔（ms）。默认 500；vitest 0。
   * 错开子进程 PostgresMemoryStore.init，避免向量迁移互锁。
   */
  forkStaggerMs?: number;
  /** child 把 progress/done POST 给父进程；缺省 publishColleagueEvent。 */
  publishEvent?: (event: ColleagueChildEvent) => Promise<void>;
}

const RESULT_CAP = 8_000;
const MAX_MAIL = 100;
const TOOL_BUDGET = 12;
const DEFAULT_TIMEOUT_MINUTES = 15;
const ASK_TIMEOUT_CAP_MINUTES = 8;
const WORKER_IDLE_POLL_MS = 2_000;
const MAX_MAIL_CHAIN = 3;
const PROGRESS_DEBOUNCE_MS = 20_000;
const WRAPUP_TIMEOUT_MS = 60_000;
const WRAPUP_TOOL_BUDGET = 2;
const WRAPUP_BRIEF_CAP = 1_200;
/** 验收只许记忆工具，绝不含 *.delegate / 同事 *.status，避免递归派单。 */
const WRAPUP_TOOL_ALLOWLIST: readonly string[] = ['memory.list', 'memory.remember'];
const NUDGE_TIMEOUT_MS = 60_000;
const NUDGE_USER_MESSAGE =
  '【小夜催交】上一封把工具调用写成了正文/只报了进度。请立刻用自然语言交完整简报：结论、要点、要不要再派。不要再调工具。';
const COMMIT_FAIL_NUDGE_PREFIX = '【小夜催交】文件改了但提交失败';
/** 进度半成品：开头是「现在做/接下来/正在做交付前自检」，且没有像样的简报。 */
const PROGRESS_STUB_START_RE = /^(现在做|接下来|正在做交付前自检)/;
const PROGRESS_STUB_PHRASE_RE = /现在做交付前自检|正在做交付前自检/;
const SUBSTANTIAL_BRIEF_CHARS = 160;

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

/** 五位同事互问 / 转交；嵌套 ask 时从 allowlist 剥掉。*.delegate 仍只给小夜。 */
export const COLLEAGUE_MAIL_TOOLS: readonly string[] = ['mail.ask', 'mail.send'];

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
  xiaozhi: ['web.search', 'web.fetch', 'github.search_repos', 'time.get'],
};

/**
 * 同事会话工具白名单：共享检索/记忆 + 岗位工具；永远不含 *.delegate 与同事 *.status。
 * system.status 是巡检工具，给小优保留。
 */
export function colleagueToolAllowlist(
  colleagueId: ColleagueId,
  options: { nested?: boolean } = {},
): string[] {
  const blocked = new Set(BLOCKED_COLLEAGUE_TOOLS);
  const names: string[] = [];
  const seen = new Set<string>();
  const mailTools = options.nested ? [] : COLLEAGUE_MAIL_TOOLS;
  for (const name of [...SHARED_COLLEAGUE_TOOLS, ...COLLEAGUE_EXTRA_TOOLS[colleagueId], ...mailTools]) {
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

/** 无 hub 会话 / 验收失败时的小夜口吻回退（与旧 formatEvent 展示一致）。 */
export function wrapUpFallback(who: string, shortId: string, ok: boolean, reply: string): string {
  const brief = truncate(reply, WRAPUP_BRIEF_CAP);
  if (ok) return `小夜：${who}回来了。${brief ? `\n${brief}` : ''}`;
  return `小夜：${who}这单没跑完${shortId ? `（#${shortId}）` : ''}。${brief ? `\n${brief}` : ''}`;
}

/**
 * 同事回信半成品：DSML/tool XML 漏进正文，或只有「现在做交付前自检」这类进度 stub。
 * 启发式收紧：真正的验收表里提到「自检」但正文够长，不算没交完。
 */
export function isIncompleteColleagueReply(text: string): boolean {
  if (containsDsmlToolXml(text)) return true;
  const prose = stripDsmlToolXml(text).trim();
  if (!prose) return false;
  const looksStub = PROGRESS_STUB_START_RE.test(prose) || PROGRESS_STUB_PHRASE_RE.test(prose);
  if (!looksStub) return false;
  return prose.length < SUBSTANTIAL_BRIEF_CHARS;
}

function mailSubject(item: MailItem): string {
  const line = item.body.trim().split(/\r?\n/).find((row) => row.trim().length > 0) ?? '';
  return line.slice(0, 80);
}

function isColleagueId(value: unknown): value is ColleagueId {
  return typeof value === 'string' && (COLLEAGUE_IDS as readonly string[]).includes(value);
}

const COLLEAGUE_NAME_TO_ID: Record<string, ColleagueId> = {
  小黑: 'xiaohei',
  小优: 'xiaoyou',
  小美: 'xiaomei',
  小真: 'xiaozhen',
  小知: 'xiaozhi',
};

/** 接受短 id 或中文名（小真 / xiaozhen）。小夜不是同事。 */
export function parseColleagueId(value: string): ColleagueId | undefined {
  const key = value.trim();
  if (isColleagueId(key)) return key;
  return COLLEAGUE_NAME_TO_ID[key];
}

export function isXiaoyeRef(value: string): boolean {
  const key = value.trim();
  return key === '小夜' || key === 'xiaoye';
}

function nextMailChain(
  parent: ColleagueId[] | undefined,
  from: 'xiaoye' | ColleagueId,
): ColleagueId[] {
  const base = parent ?? [];
  if (from === 'xiaoye') return [...base];
  return [...base, from];
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

const TOOL_PROGRESS_LABEL: Record<string, string> = {
  'web.search': '正在检索网页',
  'web.fetch': '正在阅读网页',
  'github.search_repos': '正在搜索 GitHub',
  'filesystem.search': '正在搜索文件',
  'coding.run': '正在写代码',
  'server.shell': '正在执行命令',
  'system.status': '正在查看系统状态',
  'memory.list': '正在查阅记忆',
  'memory.remember': '正在写入记忆',
  'time.get': '正在看时间',
  'mail.ask': '正在问同事',
  'mail.send': '正在转交任务',
};

/** 白名单外或未知工具不冒进度；已知工具用人话，不用原始英文名。 */
export function humanizeColleagueToolProgress(
  toolName: string,
  allowlist: readonly string[],
): string | undefined {
  if (!allowlist.includes(toolName)) return undefined;
  return TOOL_PROGRESS_LABEL[toolName];
}

/**
 * 同事办公室：五位同事各有一条持久 Postgres 会话 + 文件收件箱。
 * 生产默认 child_process.fork 五份子进程（同容器），每人独立事件循环跑 runChat；
 * vitest 保持进程内 worker。小夜 *.delegate / mail.send / mail.ask 只入队。
 * wrap-up 始终在父进程小夜 hub 会话上跑。
 */
export class ColleagueOffice {
  readonly #store: SessionStore;
  readonly #runners: ColleagueRunners;
  readonly #mailboxDir: string;
  readonly #gitRepoDir: string | null;
  readonly #sessionIds = new Map<ColleagueId, string>();
  readonly #mail = new Map<ColleagueId, MailItem[]>();
  readonly #tasks = new Map<string, ColleagueTask>();
  readonly #pendingDone = new Map<string, ColleagueTaskEvent>();
  readonly #unsubs: Array<() => void> = [];
  readonly #listeners = new Set<(event: ColleagueTaskEvent) => void>();
  /** 每位同事 worker 空闲时的唤醒函数（条件变量）。 */
  readonly #wakes = new Map<ColleagueId, () => void>();
  /** mail.ask 等待某封信 settle 的订阅者。 */
  readonly #mailWaiters = new Map<string, Set<() => void>>();
  /** 入队时的 directory / timeout，重启后 #tasks 为空则用默认值。 */
  readonly #mailOptions = new Map<string, { directory: string; timeoutMinutes: number }>();
  readonly #gitSnapshots = new Map<string, GitStatusSnapshot>();
  #conversation?: ColleagueConversation;
  #persistChain: Promise<void> = Promise.resolve();
  #gitChain: Promise<unknown> = Promise.resolve();
  #attached = false;
  #workersStarted = false;
  #stopping = false;
  #isolation: ColleagueIsolation;
  readonly #workerColleagueId?: ColleagueId;
  readonly #forkWorker: (id: ColleagueId) => ChildProcess;
  readonly #forkStaggerMs: number;
  readonly #publishEvent?: (event: ColleagueChildEvent) => Promise<void>;
  readonly #children = new Map<ColleagueId, ChildRecord>();
  readonly #wrappedMailIds = new Set<string>();
  #mailboxWatchTimer?: ReturnType<typeof setTimeout>;
  #usedInProcessFallback = false;

  constructor(options: ColleagueOfficeOptions) {
    this.#store = options.store;
    this.#runners = options.runners;
    this.#mailboxDir = options.mailboxDir ?? path.resolve('./data/mailboxes');
    this.#gitRepoDir = options.gitRepoDir === undefined ? DEFAULT_GIT_REPO_DIR : options.gitRepoDir;
    this.#isolation = options.isolation ?? 'inprocess';
    this.#workerColleagueId = options.workerColleagueId;
    this.#forkWorker = options.forkWorker ?? forkColleagueWorker;
    this.#forkStaggerMs = options.forkStaggerMs ?? colleagueForkStaggerMs();
    this.#publishEvent = options.publishEvent;
  }

  /** 生产在 ConversationService 建好后注入；测试可传假 runChat。 */
  attachConversation(conversation: ColleagueConversation): void {
    this.#conversation = conversation;
  }

  /**
   * 停掉五位同事的信箱循环（清 2s idle timer）。进行中的 runChat 仍跑完当前封。
   * 进程退出时调用；测试 afterEach 也调，避免 vitest 被 timer 挂住。
   */
  close(): void {
    this.#stopping = true;
    if (this.#mailboxWatchTimer) {
      clearTimeout(this.#mailboxWatchTimer);
      this.#mailboxWatchTimer = undefined;
    }
    for (const rec of this.#children.values()) {
      if (rec.restartTimer) {
        clearTimeout(rec.restartTimer);
        rec.restartTimer = undefined;
      }
      try {
        rec.child.kill('SIGTERM');
      } catch {
        // 已退
      }
    }
    for (const id of COLLEAGUE_IDS) {
      const wake = this.#wakes.get(id);
      if (wake) wake();
    }
    for (const waiters of this.#mailWaiters.values()) {
      for (const notify of waiters) notify();
    }
    this.#mailWaiters.clear();
  }

  /** SIGTERM：先 close 再等子进程退出；超时 SIGKILL。 */
  async closeAndWait(timeoutMs = 2_500): Promise<void> {
    this.close();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (![...this.#children.values()].some((rec) => rec.alive)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const rec of this.#children.values()) {
      if (!rec.alive) continue;
      try {
        rec.child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
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

  /** 读盘收件箱、订阅 runner 完成事件、把重启残留的 running 重置为 queued，再启动五位 worker。 */
  async hydrate(): Promise<void> {
    await mkdir(this.#mailboxDir, { recursive: true });
    for (const id of COLLEAGUE_IDS) {
      this.#mail.set(id, await this.#loadMailbox(id));
      for (const mail of this.#mail.get(id) ?? []) {
        if (mail.status === 'done' || mail.status === 'failed') {
          this.#wrappedMailIds.add(mail.id);
        }
      }
    }
    this.#attach();
    await this.#reconcile();
    await this.#startWorkers();
  }

  /**
   * 小夜派单：写信入收件箱并唤醒该同事 worker。有 conversation 时由 worker
   * headless runChat；否则回退 runner.delegate（异步 dsh / SSE）。
   * 同事互问 / 转交走 ask / sendFrom。调用方不直接跑 #runLoop。
   */
  async delegate(
    colleagueId: string,
    task: string,
    options: ColleagueDispatchOptions = {},
  ): Promise<ColleagueTask> {
    return this.#dispatch(colleagueId, task.trim(), {
      ...options,
      from: options.from ?? 'xiaoye',
      wait: options.wait ?? false,
      nested: options.nested ?? false,
    });
  }

  /**
   * 同事同步询问：写信到对方收件箱并等待回信。被问方 allowlist 不含 mail.*（hop 1）。
   * 不跑小夜 wrap-up，不发 done 事件（避免微信中途冒「小真回来了」）。
   */
  async ask(
    to: string,
    question: string,
    options: ColleagueDispatchOptions & { from: ColleagueId },
  ): Promise<ColleagueTask> {
    const body = question.trim();
    if (!body) throw new Error('问题不能为空');
    if (isXiaoyeRef(to)) throw new Error('不能问小夜');
    const toId = parseColleagueId(to);
    if (!toId) throw new Error(`unknown colleague: ${to}`);
    if (toId === options.from) throw new Error('不能问自己');
    const parent = this.#callerMail(options.from);
    if (parent?.nested) {
      throw new Error('回答来信时不能再问其他同事');
    }
    return this.#dispatch(toId, body, {
      directory: options.directory,
      timeoutMinutes: options.timeoutMinutes,
      hubSessionId: options.hubSessionId ?? parent?.hubSessionId,
      from: options.from,
      wait: true,
      nested: true,
      chain: options.chain ?? parent?.chain,
    });
  }

  /**
   * 同事异步转交：立即返回 taskId。cycle / 跳数检查；完成时用原 hubSessionId 做小夜 wrap-up。
   */
  async sendFrom(
    from: ColleagueId,
    to: string,
    body: string,
    options: ColleagueDispatchOptions = {},
  ): Promise<ColleagueTask> {
    const text = body.trim();
    if (!text) throw new Error('正文不能为空');
    if (isXiaoyeRef(to)) throw new Error('不能转交给小夜');
    const toId = parseColleagueId(to);
    if (!toId) throw new Error(`unknown colleague: ${to}`);
    if (toId === from) throw new Error('不能转交给自己');
    const parent = this.#callerMail(from);
    if (parent?.nested) {
      throw new Error('回答来信时不能再转交其他同事');
    }
    return this.#dispatch(toId, text, {
      directory: options.directory,
      timeoutMinutes: options.timeoutMinutes,
      hubSessionId: options.hubSessionId ?? parent?.hubSessionId,
      from,
      wait: false,
      nested: false,
      chain: options.chain ?? parent?.chain,
    });
  }

  /** ToolContext.sessionId 是调用方同事会话，用来认 from；不是微信 hub。 */
  colleagueIdForSession(sessionId: string): ColleagueId | undefined {
    const id = sessionId.trim();
    if (!id) return undefined;
    for (const [colleagueId, sid] of this.#sessionIds) {
      if (sid === id) return colleagueId;
    }
    return undefined;
  }

  async #dispatch(
    colleagueId: string,
    body: string,
    options: ColleagueDispatchOptions,
  ): Promise<ColleagueTask> {
    if (!isColleagueId(colleagueId)) {
      throw new Error(`unknown colleague: ${colleagueId}`);
    }
    const from = options.from ?? 'xiaoye';
    if (from === colleagueId) {
      throw new Error('不能给自己写信');
    }
    const chain = this.#assertSendChain(colleagueId, from, options.chain, options.wait === true);
    const hubSessionId = this.#sanitizeHubSessionId(options.hubSessionId);
    const mail: MailItem = {
      id: randomUUID(),
      from,
      to: colleagueId,
      body,
      createdAt: new Date().toISOString(),
      status: 'queued',
      ...(hubSessionId ? { hubSessionId } : {}),
      ...(chain.length ? { chain } : {}),
      ...(options.nested ? { nested: true } : {}),
    };
    if (options.wait && !this.#conversation) {
      throw new Error('同事会话未接入，无法同步询问');
    }
    this.#pushMail(colleagueId, mail);
    if (this.#conversation) {
      return this.#enqueueConversation(colleagueId, mail, body, options);
    }
    await this.#persist(colleagueId);
    return this.#delegateViaRunner(colleagueId, mail, body, options);
  }

  /**
   * 转交：to 已在链路中则拒绝（防打转）；链路过长拒绝。
   * 同步 ask 不走跳数上限（hop 1 由 nested allowlist 保证）。
   */
  #assertSendChain(
    to: ColleagueId,
    from: 'xiaoye' | ColleagueId,
    parentChain: ColleagueId[] | undefined,
    isAsk: boolean,
  ): ColleagueId[] {
    const chain = nextMailChain(parentChain, from);
    if (from === 'xiaoye' || isAsk) return chain;
    if (chain.includes(to)) {
      throw new Error(`不能转交给已在链路中的同事，防止打转`);
    }
    if (chain.length > MAX_MAIL_CHAIN) {
      throw new Error(`转交跳数已达上限（${MAX_MAIL_CHAIN}）`);
    }
    return chain;
  }

  #callerMail(colleagueId: ColleagueId): MailItem | undefined {
    const items = this.#mail.get(colleagueId) ?? [];
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item && (item.status === 'queued' || item.status === 'running')) return item;
    }
    return items.at(-1);
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

  /**
   * 只入队：写 task 记录、发 started、唤醒该同事 worker。不在调用栈上跑 #runLoop。
   * mail.ask（wait）在此等待该 MailItem 被 worker settle。
   */
  async #enqueueConversation(
    colleagueId: ColleagueId,
    mail: MailItem,
    body: string,
    options: ColleagueDispatchOptions,
  ): Promise<ColleagueTask> {
    const name = colleagueName(colleagueId);
    let timeoutMinutes = clampTimeoutMinutes(options.timeoutMinutes);
    if (mail.nested) timeoutMinutes = Math.min(timeoutMinutes, ASK_TIMEOUT_CAP_MINUTES);
    const directory = path.resolve(options.directory ?? '/app');
    const taskId = randomUUID();
    mail.taskId = taskId;
    this.#mailOptions.set(mail.id, { directory, timeoutMinutes });

    const record: ColleagueTask = {
      id: taskId,
      colleague: name,
      task: body,
      directory,
      status: 'running',
      createdAt: mail.createdAt,
      startedAt: new Date().toISOString(),
      output: '',
      ...(mail.hubSessionId ? { hubSessionId: mail.hubSessionId } : {}),
      ...(mail.chain ? { chain: mail.chain } : {}),
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

    await this.#persist(colleagueId);
    this.#wake(colleagueId);
    if (options.wait) {
      await this.#waitForMailSettled(
        colleagueId,
        mail.id,
        timeoutMinutes * 60 * 1000,
      );
    }
    return this.#tasks.get(taskId) ?? record;
  }

  async #startWorkers(): Promise<void> {
    if (this.#workersStarted) return;
    this.#workersStarted = true;
    if (this.#isolation === 'child') {
      const id = this.#workerColleagueId;
      if (!id) {
        console.error('[colleagues] child isolation 缺少 workerColleagueId');
        return;
      }
      void this.#workerLoop(id);
      return;
    }
    if (this.#isolation === 'parent') {
      const spawned = await this.#forkAll();
      if (spawned === 0) {
        this.#fallbackInProcess('fork() 一个都没拉起');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      const alive = [...this.#children.values()].filter((rec) => rec.alive).length;
      if (alive === 0) {
        for (const rec of this.#children.values()) {
          if (rec.restartTimer) {
            clearTimeout(rec.restartTimer);
            rec.restartTimer = undefined;
          }
        }
        this.#fallbackInProcess('子进程全部瞬间退出');
        return;
      }
      this.#startMailboxWatcher();
      console.log(`[colleagues] forked ${alive} mailbox worker(s)`);
      return;
    }
    for (const id of COLLEAGUE_IDS) {
      void this.#workerLoop(id);
    }
  }

  async #workerLoop(colleagueId: ColleagueId): Promise<void> {
    while (!this.#stopping) {
      if (this.#isolation !== 'inprocess') {
        this.#mail.set(colleagueId, await this.#loadMailbox(colleagueId));
      }
      if (!this.#conversation) {
        await this.#waitForWork(colleagueId);
        continue;
      }
      const mail = this.#oldestQueued(colleagueId);
      if (!mail) {
        await this.#waitForWork(colleagueId);
        continue;
      }
      await this.#processQueuedMail(colleagueId, mail);
    }
  }

  #oldestQueued(colleagueId: ColleagueId): MailItem | undefined {
    const queued = (this.#mail.get(colleagueId) ?? []).filter((item) => item.status === 'queued');
    queued.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return queued[0];
  }

  async #processQueuedMail(colleagueId: ColleagueId, mail: MailItem): Promise<void> {
    if (mail.status !== 'queued') return;
    const name = colleagueName(colleagueId);
    const options = this.#mailOptions.get(mail.id);
    const directory = options?.directory ?? path.resolve('/app');
    let timeoutMinutes = options?.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
    if (mail.nested) timeoutMinutes = Math.min(timeoutMinutes, ASK_TIMEOUT_CAP_MINUTES);

    let record = mail.taskId ? this.#tasks.get(mail.taskId) : undefined;
    if (!record) {
      const taskId = mail.taskId ?? randomUUID();
      mail.taskId = taskId;
      record = {
        id: taskId,
        colleague: name,
        task: mail.body,
        directory,
        status: 'running',
        createdAt: mail.createdAt,
        startedAt: new Date().toISOString(),
        output: '',
        ...(mail.hubSessionId ? { hubSessionId: mail.hubSessionId } : {}),
        ...(mail.chain ? { chain: mail.chain } : {}),
      };
      this.#tasks.set(taskId, record);
      // 父进程入队已 emit started；子进程补记录时不要再 toast「已开工」。
      if (this.#isolation !== 'child') {
        this.#emit({
          type: 'started',
          taskId,
          status: 'running',
          colleague: name,
          text: this.#runners[colleagueId].spec.startedText,
        });
      }
    }

    mail.status = 'running';
    await this.#persist(colleagueId);
    await this.#snapshotGit(mail.id);
    await this.#runLoop(colleagueId, mail, record, timeoutMinutes);
  }

  #waitForWork(colleagueId: ColleagueId): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#wakes.get(colleagueId) === done) this.#wakes.delete(colleagueId);
        resolve();
      };
      const timer = setTimeout(done, WORKER_IDLE_POLL_MS);
      this.#wakes.set(colleagueId, done);
    });
  }

  /** 入队后唤醒；用 0ms macrotask，让 delegate/send 先返回 queued，runChat 等 worker tick。 */
  #wake(colleagueId: ColleagueId): void {
    const done = this.#wakes.get(colleagueId);
    if (!done) return;
    setTimeout(done, 0);
  }

  async #waitForMailSettled(
    colleagueId: ColleagueId,
    mailId: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#stopping) {
      if (this.#isolation !== 'inprocess') {
        this.#mail.set(colleagueId, await this.#loadMailbox(colleagueId));
      }
      const mail = this.#findMail(colleagueId, mailId);
      if (mail && (mail.status === 'done' || mail.status === 'failed')) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('询问超时');
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const waiters = this.#mailWaiters.get(mailId);
          if (waiters) {
            waiters.delete(finish);
            if (waiters.size === 0) this.#mailWaiters.delete(mailId);
          }
          resolve();
        };
        const timer = setTimeout(finish, Math.min(50, Math.max(1, remaining)));
        let waiters = this.#mailWaiters.get(mailId);
        if (!waiters) {
          waiters = new Set();
          this.#mailWaiters.set(mailId, waiters);
        }
        waiters.add(finish);
      });
    }
  }

  #notifyMailWaiters(mailId: string): void {
    const waiters = this.#mailWaiters.get(mailId);
    if (!waiters) return;
    this.#mailWaiters.delete(mailId);
    for (const notify of waiters) notify();
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

    const fromName = mail.from === 'xiaoye' ? '小夜' : colleagueName(mail.from);
    const userMessage = `【${fromName}来信】\n${mail.body}`;
    const toolAllowlist = colleagueToolAllowlist(colleagueId, { nested: Boolean(mail.nested) });
    let doneText: string | undefined;
    let errorText: string | undefined;
    let sawTerminal = false;
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
        if (env.type === 'agent.tool_call') {
          if (sawTerminal) continue;
          for (const toolName of toolCallNames(env.payload)) {
            const text = humanizeColleagueToolProgress(toolName, toolAllowlist);
            if (!text) continue;
            this.#emitProgress(record, name, text);
          }
          continue;
        }
        if (env.type === 'chat.done') {
          doneText = String(payloadRecord(env.payload).text ?? '');
          sawTerminal = true;
          continue;
        }
        if (env.type === 'chat.error') {
          errorText = String(payloadRecord(env.payload).error ?? '对话失败');
          sawTerminal = true;
        }
      }
    } catch (error) {
      if (!sawTerminal) {
        errorText = error instanceof Error ? error.message : String(error);
      }
    }

    if (errorText !== undefined && doneText === undefined) {
      await this.#settle(colleagueId, mail, record, {
        ok: false,
        text: errorText,
        skipSession: sawTerminal,
      });
      return;
    }
    if (doneText === undefined) {
      await this.#settle(colleagueId, mail, record, {
        ok: false,
        text: '会话结束但未返回结果',
        skipSession: false,
      });
      return;
    }

    let text = doneText;
    let ok = true;
    if (isIncompleteColleagueReply(text)) {
      const continued = await this.#nudgeIncompleteReply(sessionId, record.id, conversation);
      if (continued && !isIncompleteColleagueReply(continued)) {
        text = continued;
      } else {
        ok = false;
        const stripped = stripDsmlToolXml(text);
        if (stripped) text = stripped;
      }
    }
    if (ok) {
      const delivery = await this.#autoCommitIfNeeded(mail, record);
      if (delivery.commitError) {
        const continued = await this.#nudgeIncompleteReply(
          sessionId,
          record.id,
          conversation,
          `${COMMIT_FAIL_NUDGE_PREFIX}: ${delivery.commitError}。请立刻用自然语言交完整简报：结论、要点、改了哪些文件。不要再调工具。`,
        );
        if (continued && !isIncompleteColleagueReply(continued)) {
          text = continued;
        }
      }
      if (delivery.wrapNote) {
        text = `${text.trimEnd()}\n\n${delivery.wrapNote}`;
      }
    }
    await this.#settle(colleagueId, mail, record, {
      ok,
      text,
      skipSession: true,
    });
  }

  /**
   * 半成品回信后再跑一轮无工具催交。必须等上一轮 runChat 迭代器结束，
   * 否则同一同事会话队列会死锁。
   */
  async #nudgeIncompleteReply(
    sessionId: string,
    taskId: string,
    conversation: ColleagueConversation,
    userMessage = NUDGE_USER_MESSAGE,
  ): Promise<string | undefined> {
    try {
      const iterator = conversation.runChat({
        sessionId,
        userMessage,
        headless: true,
        toolAllowlist: [],
        toolBudget: 0,
        signal: AbortSignal.timeout(NUDGE_TIMEOUT_MS),
        requestId: `continue:${taskId}`,
      });
      let text = '';
      for await (const env of iterator) {
        if (env.type === 'chat.done') {
          text = String(payloadRecord(env.payload).text ?? '');
          continue;
        }
        if (env.type === 'chat.error') return undefined;
      }
      const trimmed = text.trim();
      return trimmed ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }

  async #snapshotGit(mailId: string): Promise<void> {
    if (!this.#gitRepoDir) return;
    const snap = await snapshotGitStatus(this.#gitRepoDir);
    if (snap) this.#gitSnapshots.set(mailId, snap);
  }

  #withGit<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#gitChain.then(fn, fn);
    this.#gitChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #autoCommitIfNeeded(mail: MailItem, record: ColleagueTask): Promise<GitDeliveryResult> {
    const empty: GitDeliveryResult = { committed: false, pushed: false };
    if (!this.#gitRepoDir) return empty;
    if (!shouldAutoCommitMail(mail)) return empty;
    const snap = this.#gitSnapshots.get(mail.id);
    if (!snap) return empty;
    try {
      return await this.#withGit(() =>
        deliverMailChanges({
          cwd: this.#gitRepoDir as string,
          startPorcelain: snap.porcelain,
          startedAt: record.startedAt ?? mail.createdAt,
          colleague: record.colleague ?? colleagueName(mail.to),
          mailSubject: mailSubject(mail),
        }),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        committed: false,
        pushed: false,
        commitError: detail,
        wrapNote: `文件改了但提交失败: ${detail}`,
      };
    }
  }

  async #settle(
    colleagueId: ColleagueId,
    mail: MailItem,
    record: ColleagueTask,
    outcome: { ok: boolean; text: string; skipSession: boolean },
  ): Promise<void> {
    this.#gitSnapshots.delete(mail.id);
    const name = record.colleague ?? colleagueName(colleagueId);
    const reply = truncate(outcome.text);
    record.status = outcome.ok ? 'success' : 'failed';
    record.finishedAt = new Date().toISOString();
    if (outcome.ok) record.result = reply;
    else record.error = reply || '任务失败';
    await this.#finishMail(
      colleagueId,
      mail,
      { status: outcome.ok ? 'done' : 'failed', reply },
      { skipSession: outcome.skipSession },
    );
    await this.#persist(colleagueId);
    // mail.ask（nested）：不跑小夜 wrap-up、不发 done，避免微信中途冒「小真回来了」。
    if (mail.nested) return;
    if (this.#isolation === 'child') {
      await this.#publishChildEvent({
        type: 'done',
        taskId: record.id,
        status: record.status,
        colleague: name,
        result: reply,
        ...(!outcome.ok ? { error: record.error } : {}),
        mailId: mail.id,
        colleagueId,
      });
      return;
    }
    const wrapUp = await this.#wrapUpOnHub({
      mail,
      record,
      name,
      ok: outcome.ok,
      reply,
    });
    this.#emit({
      type: 'done',
      taskId: record.id,
      status: record.status,
      colleague: name,
      result: wrapUp,
      ...(!outcome.ok ? { error: record.error } : {}),
    });
  }

  /**
   * 在小夜自己的微信会话上跑短验收。失败/超时/会话忙则回退模板。
   * 验收过程中的 tool_call 不冒同事进度。
   */
  async #wrapUpOnHub(input: {
    mail: MailItem;
    record: ColleagueTask;
    name: string;
    ok: boolean;
    reply: string;
  }): Promise<string> {
    const shortId = input.record.id.slice(0, 8);
    const fallback = wrapUpFallback(input.name, shortId, input.ok, input.reply);
    const hubSessionId = this.#sanitizeHubSessionId(
      input.mail.hubSessionId ?? input.record.hubSessionId,
    );
    const conversation = this.#conversation;
    if (!hubSessionId || !conversation) return fallback;
    if (conversation.isSessionBusy?.(hubSessionId)) return fallback;

    try {
      const iterator = conversation.runChat({
        sessionId: hubSessionId,
        userMessage:
          `【同事回信】${input.name}的任务 #${shortId} 已${input.ok ? '完成' : '失败'}。` +
          `下面是她的回信，请用你自己的口吻向用户做短验收汇报：搞定了没、要点是什么、要不要再派。` +
          `不要再调 *.delegate / *.status，不要抄全文简报。` +
          `禁止说「等她下一条」「还在自检」「正式回报还没来」。这封信就是终稿。` +
          `若内容明显没写完，就说没交完、已知要点是什么，不要让用户等待。\n\n${input.reply}`,
        headless: true,
        toolAllowlist: [...WRAPUP_TOOL_ALLOWLIST],
        toolBudget: WRAPUP_TOOL_BUDGET,
        signal: AbortSignal.timeout(WRAPUP_TIMEOUT_MS),
        requestId: `wrapup:${input.record.id}`,
      });
      let text = '';
      for await (const env of iterator) {
        if (env.type === 'agent.tool_call') continue;
        if (env.type === 'chat.done') {
          text = String(payloadRecord(env.payload).text ?? '');
          continue;
        }
        if (env.type === 'chat.error') return fallback;
      }
      const trimmed = text.trim();
      return trimmed ? truncate(trimmed) : fallback;
    } catch {
      return fallback;
    }
  }

  /** 同事会话 id 不能当 hub；缺省 / 空字符串视为没有。 */
  #sanitizeHubSessionId(hubSessionId: string | undefined): string | undefined {
    if (typeof hubSessionId !== 'string') return undefined;
    const id = hubSessionId.trim();
    if (!id) return undefined;
    for (const colleagueSessionId of this.#sessionIds.values()) {
      if (colleagueSessionId === id) return undefined;
    }
    return id;
  }

  /**
   * 每任务最多 20s 一条进度 toast；第一条人话永远放行。
   * 相同文案对本任务只报一次（过了 20s 也不再重复「正在写代码」）。
   * 窗口内不同文案仍被 debounce 合并。非白名单工具在调用方已过滤。
   */
  #emitProgress(record: ColleagueTask, name: string, text: string): void {
    const now = Date.now();
    const lastAt = record.progressEmittedAt ?? 0;
    const first = lastAt === 0;
    record.progress = text;
    if (record.lastProgressLabel === text) return;
    if (!first && now - lastAt < PROGRESS_DEBOUNCE_MS) return;
    record.progressEmittedAt = now;
    record.lastProgressLabel = text;
    const event = {
      type: 'progress' as const,
      taskId: record.id,
      status: 'running' as const,
      colleague: name,
      text,
    };
    this.#emit(event);
    if (this.#isolation === 'child') {
      void this.#publishChildEvent({ ...event, colleagueId: this.#workerColleagueId });
    }
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
        if (mail.status !== 'queued' && mail.status !== 'running') continue;
        if (mail.taskId) {
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
        }
        // 会话路径任务在进程内，重启后 #tasks 为空：running 退回 queued，让 worker 重试。
        if (mail.status === 'running') {
          mail.status = 'queued';
          delete mail.reply;
          changed = true;
        }
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
    this.#notifyMailWaiters(mail.id);
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
        if (this.#isolation === 'inprocess') {
          await this.#writeMailboxFile(colleagueId, this.#mail.get(colleagueId) ?? []);
          return;
        }
        const mem = this.#mail.get(colleagueId) ?? [];
        await withExclusiveFileLock(this.#mailboxLockPath(colleagueId), async () => {
          const disk = await this.#loadMailbox(colleagueId);
          const merged = mergeMailboxItems(disk, mem);
          this.#mail.set(colleagueId, merged);
          await this.#writeMailboxFile(colleagueId, merged);
        });
      } catch (error) {
        console.warn(
          `[colleagues] persist ${colleagueId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    this.#persistChain = run.catch(() => {});
    await run;
  }

  #mailboxLockPath(colleagueId: ColleagueId): string {
    return `${this.#mailboxPath(colleagueId)}.lock`;
  }

  async #writeMailboxFile(colleagueId: ColleagueId, records: MailItem[]): Promise<void> {
    await mkdir(this.#mailboxDir, { recursive: true });
    const file = this.#mailboxPath(colleagueId);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(records, null, 2), 'utf8');
    await rename(tmp, file);
  }

  async #forkAll(): Promise<number> {
    let spawned = 0;
    if (this.#forkStaggerMs > 0) {
      console.log(`[colleagues] forking workers with ${this.#forkStaggerMs}ms stagger`);
    }
    for (const id of COLLEAGUE_IDS) {
      if (this.#stopping) break;
      if (spawned > 0 && this.#forkStaggerMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.#forkStaggerMs));
        if (this.#stopping) break;
      }
      if (this.#forkOne(id)) spawned += 1;
    }
    return spawned;
  }

  #forkOne(id: ColleagueId): ChildProcess | undefined {
    try {
      const child = this.#forkWorker(id);
      const rec: ChildRecord = {
        child,
        alive: true,
        restarts: [],
      };
      this.#children.set(id, rec);
      child.on('exit', (code, signal) => {
        rec.alive = false;
        this.#onChildExit(id, code, signal);
      });
      child.on('error', (error) => {
        rec.alive = false;
        console.error(
          `[colleagues] child ${id} error: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return child;
    } catch (error) {
      console.error(
        `[colleagues] fork ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  #onChildExit(id: ColleagueId, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#stopping || this.#usedInProcessFallback) return;
    const rec = this.#children.get(id);
    if (!rec) return;
    const now = Date.now();
    rec.restarts = rec.restarts.filter((ts) => now - ts < RESTART_WINDOW_MS);
    if (rec.restarts.length >= MAX_CHILD_RESTARTS) {
      console.error(
        `[colleagues] child ${id} 在 10 分钟内退出 ${rec.restarts.length} 次，停止拉起该同事`,
      );
      this.#maybeFallbackInProcess();
      return;
    }
    rec.restarts.push(now);
    const backoff = Math.min(8_000, 500 * 2 ** rec.restarts.length);
    console.warn(
      `[colleagues] child ${id} exited code=${code} signal=${signal}, restart in ${backoff}ms`,
    );
    rec.restartTimer = setTimeout(() => {
      rec.restartTimer = undefined;
      if (this.#stopping) return;
      this.#forkOne(id);
    }, backoff);
    rec.restartTimer.unref?.();
  }

  #maybeFallbackInProcess(): void {
    if (this.#isolation !== 'parent' || this.#usedInProcessFallback) return;
    const busy = [...this.#children.values()].some((rec) => rec.alive || rec.restartTimer);
    if (busy) return;
    this.#fallbackInProcess('所有子进程已放弃重启');
  }

  #fallbackInProcess(reason: string): void {
    if (this.#usedInProcessFallback) return;
    this.#usedInProcessFallback = true;
    this.#isolation = 'inprocess';
    console.error(
      `[colleagues] FORK FAILED（${reason}）——回退到进程内 worker。五位同事仍共享同一事件循环。`,
    );
    for (const id of COLLEAGUE_IDS) {
      void this.#workerLoop(id);
    }
  }

  #startMailboxWatcher(): void {
    const tick = async (): Promise<void> => {
      if (this.#stopping) return;
      try {
        await this.#scanSettledMail();
      } catch (error) {
        console.warn(
          `[colleagues] mailbox watch: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (this.#stopping) return;
      this.#mailboxWatchTimer = setTimeout(() => void tick(), MAILBOX_WATCH_MS);
      this.#mailboxWatchTimer.unref?.();
    };
    void tick();
  }

  async #scanSettledMail(): Promise<void> {
    for (const id of COLLEAGUE_IDS) {
      const disk = await this.#loadMailbox(id);
      const merged = mergeMailboxItems(disk, this.#mail.get(id) ?? []);
      this.#mail.set(id, merged);
      for (const mail of disk) {
        if (mail.status !== 'done' && mail.status !== 'failed') continue;
        if (mail.nested) continue;
        if (this.#wrappedMailIds.has(mail.id)) continue;
        await this.#wrapUpSettledMail(id, mail);
      }
    }
  }

  /**
   * 子进程 POST 的 progress/done。done 后父进程跑小夜 wrap-up 再 SSE。
   * 幂等：同一封信 wrap-up 只跑一次。
   */
  async ingestChildEvent(event: ColleagueChildEvent): Promise<void> {
    if (event.type === 'progress') {
      const record = this.#tasks.get(event.taskId);
      if (record) {
        record.progress = event.text ?? record.progress;
      }
      this.#emit(event);
      return;
    }
    if (event.type !== 'done') return;
    const colleagueId =
      event.colleagueId ??
      (COLLEAGUE_IDS.find((id) => colleagueName(id) === event.colleague) as ColleagueId | undefined);
    if (colleagueId) {
      this.#mail.set(colleagueId, await this.#loadMailbox(colleagueId));
      const mail =
        (event.mailId ? this.#findMail(colleagueId, event.mailId) : undefined) ??
        this.#findByTaskId(colleagueId, event.taskId);
      if (mail) {
        await this.#wrapUpSettledMail(colleagueId, mail);
        return;
      }
    }
    // 找不到信也把 done 发出去（回退文案），避免微信丢完成通知。
    this.#emit(event);
  }

  async #wrapUpSettledMail(colleagueId: ColleagueId, mail: MailItem): Promise<void> {
    if (this.#wrappedMailIds.has(mail.id)) return;
    if (mail.nested) return;
    if (mail.status !== 'done' && mail.status !== 'failed') return;
    this.#wrappedMailIds.add(mail.id);
    const name = colleagueName(colleagueId);
    const ok = mail.status === 'done';
    const reply = truncate(mail.reply ?? '');
    let record = mail.taskId ? this.#tasks.get(mail.taskId) : undefined;
    if (!record) {
      const taskId = mail.taskId ?? mail.id;
      mail.taskId = taskId;
      record = {
        id: taskId,
        colleague: name,
        task: mail.body,
        directory: path.resolve('/app'),
        status: ok ? 'success' : 'failed',
        createdAt: mail.createdAt,
        startedAt: mail.createdAt,
        finishedAt: new Date().toISOString(),
        output: '',
        ...(ok ? { result: reply } : { error: reply || '任务失败' }),
        ...(mail.hubSessionId ? { hubSessionId: mail.hubSessionId } : {}),
        ...(mail.chain ? { chain: mail.chain } : {}),
      };
      this.#tasks.set(taskId, record);
    } else {
      record.status = ok ? 'success' : 'failed';
      record.finishedAt = record.finishedAt ?? new Date().toISOString();
      if (ok) record.result = reply;
      else record.error = reply || '任务失败';
    }
    const wrapUp = await this.#wrapUpOnHub({
      mail,
      record,
      name,
      ok,
      reply,
    });
    this.#emit({
      type: 'done',
      taskId: record.id,
      status: record.status,
      colleague: name,
      result: wrapUp,
      ...(!ok ? { error: record.error } : {}),
    });
  }

  async #publishChildEvent(event: ColleagueChildEvent): Promise<void> {
    const publish = this.#publishEvent ?? publishColleagueEvent;
    await publish(event);
  }
}

const MAX_CHILD_RESTARTS = 5;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAILBOX_WATCH_MS = 200;

interface ChildRecord {
  child: ChildProcess;
  alive: boolean;
  restarts: number[];
  restartTimer?: ReturnType<typeof setTimeout>;
}

function mergeMailboxItems(disk: MailItem[], mem: MailItem[]): MailItem[] {
  const rank: Record<string, number> = { queued: 0, running: 1, done: 2, failed: 2 };
  const map = new Map<string, MailItem>();
  for (const item of disk) map.set(item.id, item);
  for (const item of mem) {
    const prev = map.get(item.id);
    if (!prev) {
      map.set(item.id, item);
      continue;
    }
    const rp = rank[prev.status] ?? 0;
    const ri = rank[item.status] ?? 0;
    if (ri > rp) {
      map.set(item.id, item);
    } else if (ri === rp) {
      map.set(item.id, {
        ...prev,
        ...item,
        ...(prev.reply && !item.reply ? { reply: prev.reply } : {}),
      });
    }
  }
  const items = [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (items.length > MAX_MAIL) items.splice(0, items.length - MAX_MAIL);
  return items;
}
