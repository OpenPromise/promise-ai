import { randomUUID } from 'node:crypto';
import type { ChatMessage, MessageRole, Session, ToolCallInfo } from '@personal-ai/types';

export * from './memory.js';
export * from './postgres.js';
export * from './postgres-sessions.js';
export * from './tasks.js';
export * from './profile.js';
export * from './timeline.js';
export * from './reminders.js';

export class SessionNotFoundError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

export interface CreateSessionInput {
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface AddMessageInput {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCallInfo[];
  toolCallId?: string;
}

export interface UpdateSessionInput {
  /** Replaces the whole message list (used by context compaction). */
  messages?: ChatMessage[];
  /** Merges into the existing metadata (used for compaction bookkeeping). */
  metadata?: Record<string, unknown>;
  /** Refresh a colleague (or other) session's system prompt without wiping history. */
  systemPrompt?: string;
  /**
   * 条件替换护栏（压缩用）：只有当前 messages 数量等于该值时才会整列替换，
   * 防止压缩的"读→LLM 摘要→写回"窗口里其它通道追加的消息被覆盖。
   * 不匹配时静默跳过本次写回（保持现状），由调用方下一轮重试。
   */
  expectedMessageCount?: number;
}

export interface SessionStore {
  createSession(input?: CreateSessionInput): Promise<Session>;
  getSession(sessionId: string): Promise<Session>;
  addMessage(sessionId: string, input: AddMessageInput): Promise<Session>;
  updateSession(sessionId: string, input: UpdateSessionInput): Promise<Session>;
  listSessions(): Promise<Session[]>;
}

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, Session>();

  async createSession(input: CreateSessionInput = {}): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      systemPrompt: input.systemPrompt ?? '',
      messages: [],
      createdAt: now,
      updatedAt: now,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  async getSession(sessionId: string): Promise<Session> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    return session;
  }

  async addMessage(sessionId: string, input: AddMessageInput): Promise<Session> {
    const session = await this.getSession(sessionId);
    const message: ChatMessage = {
      id: randomUUID(),
      sessionId,
      role: input.role,
      content: input.content,
      createdAt: new Date().toISOString(),
      ...(input.toolCalls ? { toolCalls: input.toolCalls } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    };
    session.messages.push(message);
    session.updatedAt = new Date().toISOString();
    return session;
  }

  async updateSession(sessionId: string, input: UpdateSessionInput): Promise<Session> {
    const session = await this.getSession(sessionId);
    // 条件替换护栏：期望消息数不匹配（并发新增/变更）时跳过写回，保持现状
    if (
      input.expectedMessageCount !== undefined &&
      session.messages.length !== input.expectedMessageCount
    ) {
      return session;
    }
    if (input.messages) {
      session.messages = input.messages;
    }
    if (input.metadata) {
      session.metadata = { ...(session.metadata ?? {}), ...input.metadata };
    }
    if (input.systemPrompt !== undefined) {
      session.systemPrompt = input.systemPrompt;
    }
    session.updatedAt = new Date().toISOString();
    return session;
  }

  async listSessions(): Promise<Session[]> {
    return [...this.#sessions.values()];
  }
}
