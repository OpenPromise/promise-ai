import type { SessionStore, TimelineStore } from '@personal-ai/memory';
import type { ConversationService } from './conversation.js';

/**
 * 事件驱动监听（Mastra signals / webhook 思路）：外部事件（GitHub webhook、
 * 监控告警等）通过 HTTP 推入，HookService 用专属会话让 AI 主动评估、
 * 处理并汇报，结果经 /api/events 推送到微信等渠道。
 */

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

  constructor(deps: HookServiceDeps) {
    this.#conversation = deps.conversation;
    this.#sessions = deps.sessions;
    this.#systemPrompt = deps.systemPrompt;
    this.#timeline = deps.timeline;
  }

  onRun(listener: (event: HookRunEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 处理一个外部事件（异步 fire-and-forget，不阻塞 webhook 响应）。 */
  async handle(hookName: string, payload: unknown): Promise<void> {
    const receivedAt = new Date().toISOString();
    const summary = summarizeHookPayload(payload);
    const finishedAt = () => new Date().toISOString();
    try {
      const session = await this.#sessions.createSession({
        systemPrompt: await this.#systemPrompt(),
        metadata: { kind: 'hook' },
      });
      const message =
        `[外部事件 ${hookName}] ${summary}\n\n` +
        '请评估这个事件是否需要处理或告知用户：' +
        '如果需要用户注意，用简洁中文说明发生了什么和你的建议；' +
        '如果只是常规事件无需打扰，只回复 HEARTBEAT_OK。';
      let output = '';
      for await (const envelope of this.#conversation.runChat({
        sessionId: session.id,
        userMessage: message,
        headless: true,
      })) {
        if (envelope.type === 'chat.token') {
          output += (envelope.payload as { delta?: string }).delta ?? '';
        } else if (envelope.type === 'chat.done') {
          const text = (envelope.payload as { text?: string }).text;
          if (text) output = text;
        }
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
      const message = error instanceof Error ? error.message : String(error);
      this.#emit({
        hookName,
        status: 'error',
        summary,
        error: message.slice(0, 300),
        receivedAt,
        finishedAt: finishedAt(),
      });
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
