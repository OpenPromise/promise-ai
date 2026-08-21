import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

export interface Reminder {
  id: string;
  text: string;
  dueAt?: string;
  createdAt: string;
  done: boolean;
}

export interface CreateReminderInput {
  text: string;
  dueAt?: string;
}

export interface ReminderStore {
  add(input: CreateReminderInput): Promise<Reminder>;
  list(includeDone?: boolean): Promise<Reminder[]>;
  /** 标记提醒已完成；返回被标记的提醒，不存在时返回 undefined。 */
  markDone(id: string): Promise<Reminder | undefined>;
}

/** 内存提醒存储：进程内可用（测试/单机），重启即丢；生产用 PostgresReminderStore。 */
export class InMemoryReminderStore implements ReminderStore {
  readonly #items: Reminder[] = [];

  async add(input: CreateReminderInput): Promise<Reminder> {
    const reminder: Reminder = {
      id: randomUUID(),
      text: input.text,
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      createdAt: new Date().toISOString(),
      done: false,
    };
    this.#items.push(reminder);
    return reminder;
  }

  async list(includeDone = false): Promise<Reminder[]> {
    return this.#items
      .filter((item) => includeDone || !item.done)
      .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));
  }

  async markDone(id: string): Promise<Reminder | undefined> {
    const item = this.#items.find((r) => r.id === id);
    if (!item) return undefined;
    item.done = true;
    return { ...item };
  }
}

interface ReminderRow {
  id: string;
  text: string;
  due_at: string | null;
  created_at: string;
  done: boolean;
}

function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    text: row.text,
    ...(row.due_at ? { dueAt: row.due_at } : {}),
    createdAt: row.created_at,
    done: row.done,
  };
}

export interface PostgresReminderStoreOptions {
  connectionString: string;
  /** 可注入连接池（测试用）。 */
  pool?: pg.Pool;
}

/** Postgres 提醒存储：重启不丢，reminder-service 每 tick 扫描到期项。 */
export class PostgresReminderStore implements ReminderStore {
  readonly #pool: pg.Pool;

  constructor(options: PostgresReminderStoreOptions) {
    this.#pool = options.pool ?? new Pool({ connectionString: options.connectionString });
  }

  async init(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS reminders (
        id uuid PRIMARY KEY,
        text text NOT NULL,
        due_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        done boolean NOT NULL DEFAULT false
      )
    `);
  }

  async add(input: CreateReminderInput): Promise<Reminder> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await this.#pool.query(
      `INSERT INTO reminders (id, text, due_at, created_at, done)
       VALUES ($1, $2, $3, $4, false)`,
      [id, input.text, input.dueAt ?? null, createdAt],
    );
    return {
      id,
      text: input.text,
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      createdAt,
      done: false,
    };
  }

  async list(includeDone = false): Promise<Reminder[]> {
    const result = await this.#pool.query<ReminderRow>(
      `SELECT id, text, due_at, created_at, done
       FROM reminders
       WHERE $1::boolean OR NOT done
       ORDER BY due_at NULLS LAST, created_at`,
      [includeDone],
    );
    return result.rows.map(toReminder);
  }

  async markDone(id: string): Promise<Reminder | undefined> {
    const result = await this.#pool.query<ReminderRow>(
      `UPDATE reminders SET done = true
       WHERE id = $1
       RETURNING id, text, due_at, created_at, done`,
      [id],
    );
    const row = result.rows[0];
    return row ? toReminder(row) : undefined;
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
