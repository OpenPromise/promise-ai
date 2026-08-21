import { SessionNotFoundError, type SessionStore, type TimelineStore } from '@personal-ai/memory';
import type { ConversationService } from './conversation.js';

/**
 * 事件驱动监听（Mastra signals / webhook 思路）：外部事件（GitHub webhook、
 * 监控告警等）通过 HTTP 推入，HookService 用专属会话让 AI 主动评估、
 * 处理并汇报，结果经 /api/events 推送到微信等渠道。
 */

/** 单个 webhook 处理的总超时（含工具循环）：超时 abort，不让一条事件跑到天荒地老。 */
export const HOOK_RUN_TIMEOUT_MS = 5 * 60_000;
/** 同时处理的 webhook 上限：CI 风暴不至于开出几十条并行 agent 循环抢 LLM 配额。 */
export const HOOK_MAX_CONCURRENT_RUNS = 2;
/** 排队上限：超出直接丢弃并上报错误，避免积压把内存吃光。 */
export const HOOK_MAX_QUEUED_RUNS = 20;

export interface HookRunEvent {
  hookName: string;
  status: 'success' | 'error';
  summary: string;
  output?: string;
  error?: string;
  receivedAt: string;
  finishedAt: string;
}

export interface HookServiceDeps {
  conversation: ConversationService;
  sessions: SessionStore;
  systemPrompt: () => Promise<string>;
  timeline?: TimelineStore;
  /** 单次处理的总超时（默认 5 分钟）。 */
  runTimeoutMs?: number;
  /** 并发上限（默认 2）。 */
  maxConcurrentRuns?: number;
  /** 排队上限（默认 20）。 */
  maxQueuedRuns?: number;
}

/** 把外部 payload 压成一段可控长度的摘要（GitHub 事件优先结构化）。 */
export function summarizeHookPayload(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const action = typeof record.action === 'string' ? record.action : undefined;
    const repo =
      record.repository && typeof record.repository === 'object'
        ? ((record.repository as Record<string, unknown>).full_name as string | undefined)
        : undefined;
    const issue = record.issue as Record<string, unknown> | undefined;
    const pr = record.pull_request as Record<string, unknown> | undefined;
    const sender =
      record.sender && typeof record.sender === 'object'
        ? ((record.sender as Record<string, unknown>).login as string | undefined)
        : undefined;
    if (action && (issue || pr || repo)) {
      const title =
        typeof issue?.title === 'string'
          ? issue.title
          : typeof pr?.title === 'string'
            ? pr.title
            : undefined;
      const number = typeof issue?.number === 'number' ? `#${issue.number}` : undefined;
      return `GitHub：${repo ?? ''} ${action}${number ? ` ${number}` : ''}${title ? `「${title}」` : ''}${sender ? `（${sender}）` : ''}`.trim();
    }
  }
  try {
    return JSON.stringify(payload).slice(0, 500);
  } catch {
    return String(payload).slice(0, 500);
  }
}

export class HookService {
  readonly #conversation: ConversationService;
  readonly #sessions: SessionStore;
  readonly #systemPrompt: () => Promise<string>;
  readonly #timeline?: TimelineStore;
  readonly #listeners = new Set<(event: HookRunEvent) => void>();
  readonly #runTimeoutMs: number;
  readonly #maxConcurrentRuns: number;
  readonly #maxQueuedRuns: number;
  /** hookName -> 长期会话 id：同一来源的事件复用一个会话，不再每次新建。 */
  readonly #hookSessions = new Map<string, string>();
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(deps: HookServiceDeps) {
    this.#conversation = deps.conversation;
    this.#sessions = deps.sessions;
    this.#systemPrompt = deps.systemPrompt;
    this.#timeline = deps.timeline;
    this.#runTimeoutMs = Math.max(1, Math.floor(deps.runTimeoutMs ?? HOOK_RUN_TIMEOUT_MS));
    this.#maxConcurrentRuns = Math.max(
      1,
      Math.floor(deps.maxConcurrentRuns ?? HOOK_MAX_CONCURRENT_RUNS),
    );
    this.#maxQueuedRuns = Math.max(0, Math.floor(deps.maxQueuedRuns ?? HOOK_MAX_QUEUED_RUNS));
  }

  onRun(listener: (event: HookRunEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 丢弃某个 hook 的会话缓存（存储侧清理后下次自动重建）。 */
  forgetSession(hookName: string): void {
    this.#hookSessions.delete(hookName);
  }

  /**
   * 复用同名 hook 的长期会话：每个 webhook 新建会话会让 sessions 表随事件量
   * 线性膨胀，而 listSessions()（启动与 /api/sessions 都调用）把全部会话读进
   * 内存（N-P1-7）。会话丢失时（存储切换/清理）自动重建。
   */
  async #resolveSession(hookName: string): Promise<string> {
    const cached = this.#hookSessions.get(hookName);
    if (cached) {
      try {
        await this.#sessions.getSession(cached);
        return cached;
      } catch (error) {
        if (!(error instanceof SessionNotFoundError)) throw error;
        this.#hookSessions.delete(hookName);
      }
    }
    const session = await this.#sessions.createSession({
      systemPrompt: await this.#systemPrompt(),
      metadata: { kind: 'hook', hookName },
    });
    this.#hookSessions.set(hookName, session.id);
    return session.id;
  }

  /** 并发闸：满额时排队，队列也满则拒绝（返回 false 由调用方上报失败）。 */
  async #acquire(): Promise<boolean> {
    if (this.#active < this.#maxConcurrentRuns) {
      this.#active += 1;
      return true;
    }
    if (this.#queue.length >= this.#maxQueuedRuns) return false;
    await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#active += 1;
    return true;
  }

  #release(): void {
    this.#active -= 1;
    this.#queue.shift()?.();
  }

  /** 处理一个外部事件（异步 fire-and-forget，不阻塞 webhook 响应）。 */
  async handle(hookName: string, payload: unknown): Promise<void> {
    const receivedAt = new Date().toISOString();
    const summary = summarizeHookPayload(payload);
    const finishedAt = () => new Date().toISOString();
    const acquired = await this.#acquire();
    if (!acquired) {
      this.#emit({
        hookName,
        status: 'error',
        summary,
        error: '外部事件处理队列繁忙，已丢弃本次事件',
        receivedAt,
        finishedAt: finishedAt(),
      });
      return;
    }
    // 总超时：runChat 拿到自己的 signal，超时真正 abort 工具循环，
    // 不再只依赖 LLM 层的 idle 超时兜底。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#runTimeoutMs);
    timer.unref?.();
    try {
      const sessionId = await this.#resolveSession(hookName);
      const message =
        `[外部事件 ${hookName}] ${summary}\n\n` +
        '请评估这个事件是否需要处理或告知用户：' +
        '如果需要用户注意，用简洁中文说明发生了什么和你的建议；' +
        '如果只是常规事件无需打扰，只回复 HEARTBEAT_OK。';
      let output = '';
      for await (const envelope of this.#conversation.runChat({
        sessionId,
        userMessage: message,
        headless: true,
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
        throw new Error(`外部事件处理超过 ${Math.round(this.#runTimeoutMs / 1000)} 秒，已终止`);
      }
      await this.#timeline?.addEvent({
        type: 'system',
        summary: `外部事件 ${hookName}：${summary.slice(0, 100)}`,
        metadata: { hookName },
      });
      this.#emit({
        hookName,
        status: 'success',
        summary,
        ...(output.trim() ? { output: output.trim().slice(0, 500) } : {}),
        receivedAt,
        finishedAt: finishedAt(),
      });
    } catch (error) {
      const message = controller.signal.aborted
        ? `外部事件处理超过 ${Math.round(this.#runTimeoutMs / 1000)} 秒，已终止`
        : error instanceof Error
          ? error.message
          : String(error);
      this.#emit({
        hookName,
        status: 'error',
        summary,
        error: message.slice(0, 300),
        receivedAt,
        finishedAt: finishedAt(),
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
      this.#release();
    }
  }

  #emit(event: HookRunEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者出错不影响其他
      }
    }
  }
}
