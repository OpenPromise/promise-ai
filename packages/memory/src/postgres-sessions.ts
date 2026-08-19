import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { ChatMessage, Session } from '@personal-ai/types';
import {
  SessionNotFoundError,
  type AddMessageInput,
  type CreateSessionInput,
  type SessionStore,
  type UpdateSessionInput,
} from './index.js';

const { Pool } = pg;

export interface PostgresSessionStoreOptions {
  connectionString: string;
  /** Injectable pool (used by tests); created from connectionString otherwise. */
  pool?: pg.Pool;
}

interface SessionRow {
  id: string;
  system_prompt: string;
  messages: unknown;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    systemPrompt: row.system_prompt,
    messages: Array.isArray(row.messages) ? (row.messages as ChatMessage[]) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.metadata && typeof row.metadata === 'object'
      ? { metadata: row.metadata as Record<string, unknown> }
      : {}),
  };
}

/**
 * PostgreSQL-backed SessionStore: sessions survive agent-server restarts, so a
 * desktop client can resume the same conversation after a crash. Messages are
 * stored as one JSONB column per session, which keeps the store simple at this
 * stage (no per-message tables or joins) and matches the Session shape used by
 * the in-memory implementation.
 */
export class PostgresSessionStore implements SessionStore {
  readonly #pool: pg.Pool;

  constructor(options: PostgresSessionStoreOptions) {
    this.#pool = options.pool ?? new Pool({ connectionString: options.connectionString, max: 5 });
  }

  async init(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id uuid PRIMARY KEY,
        system_prompt text NOT NULL,
        messages jsonb NOT NULL DEFAULT '[]'::jsonb,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.#pool.query(
      'CREATE INDEX IF NOT EXISTS sessions_updated_at_idx ON sessions (updated_at DESC)',
    );
  }

  async createSession(input: CreateSessionInput = {}): Promise<Session> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.#pool.query(
      `INSERT INTO sessions (id, system_prompt, messages, metadata, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $5)`,
      [
        id,
        input.systemPrompt ?? '',
        JSON.stringify([]),
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
      ],
    );
    return this.getSession(id);
  }

  async getSession(sessionId: string): Promise<Session> {
    const result = await this.#pool.query<SessionRow>(
      `SELECT id, system_prompt, messages, metadata, created_at, updated_at
       FROM sessions WHERE id = $1`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) throw new SessionNotFoundError(sessionId);
    return toSession(row);
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
    const updatedAt = new Date().toISOString();
    await this.#pool.query(
      `UPDATE sessions SET messages = $2::jsonb, updated_at = $3 WHERE id = $1`,
      [sessionId, JSON.stringify([...session.messages, message]), updatedAt],
    );
    return this.getSession(sessionId);
  }

  async updateSession(sessionId: string, input: UpdateSessionInput): Promise<Session> {
    const session = await this.getSession(sessionId);
    const messages = input.messages ?? session.messages;
    const metadata = { ...(session.metadata ?? {}), ...(input.metadata ?? {}) };
    const updatedAt = new Date().toISOString();
    await this.#pool.query(
      `UPDATE sessions
       SET messages = $2::jsonb, metadata = $3::jsonb, updated_at = $4
       WHERE id = $1`,
      [
        sessionId,
        JSON.stringify(messages),
        Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
        updatedAt,
      ],
    );
    return this.getSession(sessionId);
  }

  async listSessions(): Promise<Session[]> {
    const result = await this.#pool.query<SessionRow>(
      `SELECT id, system_prompt, messages, metadata, created_at, updated_at
       FROM sessions ORDER BY updated_at DESC`,
    );
    return result.rows.map(toSession);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
