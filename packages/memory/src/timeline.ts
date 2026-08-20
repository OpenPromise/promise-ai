import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

/**
 * 事件时间线：按时间顺序记录"发生了什么"（OpenClaw trajectory 思路）。
 * 对话 / 任务 / 画像 / 云操作 / 生活事件统一成一条可查的时间轴，
 * 每次会话注入最近事件，让 AI 知道"我们之间发生过什么"。
 */

export type TimelineEventType =
  | 'chat'
  | 'task'
  | 'profile'
  | 'cloud'
  | 'system'
  | 'note';

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  summary: string;
  sessionId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AddTimelineEventInput {
  type: TimelineEventType;
  summary: string;
  sessionId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
}

export interface ListTimelineOptions {
  type?: TimelineEventType;
  limit?: number;
}

export interface TimelineStore {
  addEvent(input: AddTimelineEventInput): Promise<TimelineEvent>;
  listEvents(options?: ListTimelineOptions): Promise<TimelineEvent[]>;
  clear(): Promise<void>;
}

function toEvent(row: {
  id: string;
  type: string;
  summary: string;
  session_id: string | null;
  run_id: string | null;
  metadata: unknown;
  created_at: string;
}): TimelineEvent {
  return {
    id: row.id,
    type: row.type as TimelineEventType,
    summary: row.summary,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.metadata && typeof row.metadata === 'object'
      ? { metadata: row.metadata as Record<string, unknown> }
      : {}),
    // pg 把 timestamptz 解析成 Date 对象，统一转 ISO 字符串供展示/排序。
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class InMemoryTimelineStore implements TimelineStore {
  readonly #events: TimelineEvent[] = [];

  async addEvent(input: AddTimelineEventInput): Promise<TimelineEvent> {
    const event: TimelineEvent = {
      id: randomUUID(),
      type: input.type,
      summary: input.summary,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: new Date().toISOString(),
    };
    this.#events.push(event);
    return { ...event };
  }

  async listEvents(options: ListTimelineOptions = {}): Promise<TimelineEvent[]> {
    let events = this.#events;
    if (options.type) events = events.filter((event) => event.type === options.type);
    const limited = options.limit ? events.slice(-options.limit) : events;
    return [...limited].reverse();
  }

  async clear(): Promise<void> {
    this.#events.length = 0;
  }
}

export interface PostgresTimelineStoreOptions {
  connectionString: string;
}

interface TimelineRow {
  id: string;
  type: string;
  summary: string;
  session_id: string | null;
  run_id: string | null;
  metadata: unknown;
  created_at: string;
}

export class PostgresTimelineStore implements TimelineStore {
  readonly #pool: pg.Pool;

  constructor(options: PostgresTimelineStoreOptions) {
    this.#pool = new Pool({ connectionString: options.connectionString, max: 5 });
  }

  async init(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS timeline_events (
        id uuid PRIMARY KEY,
        type text NOT NULL,
        summary text NOT NULL,
        session_id uuid,
        run_id text,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.#pool.query(
      'CREATE INDEX IF NOT EXISTS timeline_events_created_idx ON timeline_events (created_at DESC)',
    );
    await this.#pool.query(
      'CREATE INDEX IF NOT EXISTS timeline_events_type_idx ON timeline_events (type, created_at DESC)',
    );
  }

  async addEvent(input: AddTimelineEventInput): Promise<TimelineEvent> {
    const id = randomUUID();
    await this.#pool.query(
      `INSERT INTO timeline_events (id, type, summary, session_id, run_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        input.type,
        input.summary,
        input.sessionId ?? null,
        input.runId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ],
    );
    return {
      id,
      type: input.type,
      summary: input.summary,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: new Date().toISOString(),
    };
  }

  async listEvents(options: ListTimelineOptions = {}): Promise<TimelineEvent[]> {
    const params: unknown[] = [];
    let sql =
      'SELECT id, type, summary, session_id, run_id, metadata, created_at FROM timeline_events';
    if (options.type) {
      params.push(options.type);
      sql += ` WHERE type = $${params.length}`;
    }
    sql += ' ORDER BY created_at DESC, id DESC';
    if (options.limit) {
      params.push(options.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const result = await this.#pool.query<TimelineRow>(sql, params);
    return result.rows.map(toEvent);
  }

  async clear(): Promise<void> {
    await this.#pool.query('DELETE FROM timeline_events');
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
