import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

export interface Task {
  id: string;
  name: string;
  /** Standard 5-field cron expression, e.g. "0 9 * * *" */
  schedule: string;
  /** Natural-language instruction executed by the agent. */
  action: string;
  /** Dedicated session that accumulates this task's history. */
  sessionId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  /** 允许使用的工具白名单；缺省 = 全部工具可用。 */
  tools?: string[];
}

export type TaskRunStatus = 'success' | 'error' | 'denied';

export interface TaskRun {
  id: string;
  taskId: string;
  status: TaskRunStatus;
  output?: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface CreateTaskInput {
  name: string;
  schedule: string;
  action: string;
  sessionId: string;
  tools?: string[];
}

export interface TaskStore {
  createTask(input: CreateTaskInput): Promise<Task>;
  listTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task | undefined>;
  updateTask(
    id: string,
    patch: Partial<
      Pick<
        Task,
        'name' | 'schedule' | 'action' | 'enabled' | 'lastRunAt' | 'sessionId' | 'tools'
      >
    >,
  ): Promise<Task | undefined>;
  deleteTask(id: string): Promise<boolean>;
  addRun(input: Omit<TaskRun, 'id'>): Promise<TaskRun>;
  listRuns(taskId?: string, limit?: number): Promise<TaskRun[]>;
  close?(): Promise<void>;
}

export class InMemoryTaskStore implements TaskStore {
  readonly #tasks = new Map<string, Task>();
  readonly #runs: TaskRun[] = [];

  async createTask(input: CreateTaskInput): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      name: input.name,
      schedule: input.schedule,
      action: input.action,
      sessionId: input.sessionId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      ...(input.tools ? { tools: input.tools } : {}),
    };
    this.#tasks.set(task.id, task);
    return { ...task };
  }

  async listTasks(): Promise<Task[]> {
    return [...this.#tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getTask(id: string): Promise<Task | undefined> {
    const task = this.#tasks.get(id);
    return task ? { ...task } : undefined;
  }

  async updateTask(
    id: string,
    patch: Partial<
      Pick<
        Task,
        'name' | 'schedule' | 'action' | 'enabled' | 'lastRunAt' | 'sessionId' | 'tools'
      >
    >,
  ): Promise<Task | undefined> {
    const task = this.#tasks.get(id);
    if (!task) return undefined;
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    return { ...task };
  }

  async deleteTask(id: string): Promise<boolean> {
    return this.#tasks.delete(id);
  }

  async addRun(input: Omit<TaskRun, 'id'>): Promise<TaskRun> {
    const run: TaskRun = { id: randomUUID(), ...input };
    this.#runs.push(run);
    return { ...run };
  }

  async listRuns(taskId?: string, limit = 50): Promise<TaskRun[]> {
    return this.#runs
      .filter((run) => !taskId || run.taskId === taskId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }
}

export interface PostgresTaskStoreOptions {
  connectionString: string;
}

interface TaskRow {
  id: string;
  name: string;
  schedule: string;
  action: string;
  session_id: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  tools: unknown;
}

interface TaskRunRow {
  id: string;
  task_id: string;
  status: string;
  output: string | null;
  error: string | null;
  started_at: string;
  finished_at: string;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    name: row.name,
    schedule: row.schedule,
    action: row.action,
    sessionId: row.session_id,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
    ...(Array.isArray(row.tools) ? { tools: row.tools as string[] } : {}),
  };
}

function toRun(row: TaskRunRow): TaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status as TaskRunStatus,
    ...(row.output ? { output: row.output } : {}),
    ...(row.error ? { error: row.error } : {}),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class PostgresTaskStore implements TaskStore {
  readonly #pool: pg.Pool;

  constructor(options: PostgresTaskStoreOptions) {
    this.#pool = new Pool({ connectionString: options.connectionString, max: 5 });
  }

  async init(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        schedule text NOT NULL,
        action text NOT NULL,
        session_id uuid NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_run_at timestamptz
      )
    `);
    await this.#pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tools jsonb');
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS task_runs (
        id uuid PRIMARY KEY,
        task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        status text NOT NULL,
        output text,
        error text,
        started_at timestamptz NOT NULL,
        finished_at timestamptz NOT NULL
      )
    `);
    await this.#pool.query(
      'CREATE INDEX IF NOT EXISTS task_runs_task_idx ON task_runs (task_id, started_at DESC)',
    );
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const id = randomUUID();
    await this.#pool.query(
      `INSERT INTO tasks (id, name, schedule, action, session_id, tools) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        input.name,
        input.schedule,
        input.action,
        input.sessionId,
        input.tools ? JSON.stringify(input.tools) : null,
      ],
    );
    const task = await this.getTask(id);
    if (!task) throw new Error('failed to read back inserted task');
    return task;
  }

  async listTasks(): Promise<Task[]> {
    const result = await this.#pool.query<TaskRow>(
      `SELECT id, name, schedule, action, session_id, enabled, created_at, updated_at, last_run_at, tools
       FROM tasks ORDER BY created_at ASC`,
    );
    return result.rows.map(toTask);
  }

  async getTask(id: string): Promise<Task | undefined> {
    const result = await this.#pool.query<TaskRow>(
      `SELECT id, name, schedule, action, session_id, enabled, created_at, updated_at, last_run_at, tools
       FROM tasks WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toTask(row) : undefined;
  }

  async updateTask(
    id: string,
    patch: Partial<
      Pick<Task, 'name' | 'schedule' | 'action' | 'enabled' | 'lastRunAt' | 'sessionId'>
    >,
  ): Promise<Task | undefined> {
    const current = await this.getTask(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    await this.#pool.query(
      `UPDATE tasks
       SET name = $2, schedule = $3, action = $4, enabled = $5, last_run_at = $6,
           session_id = $7, tools = $8, updated_at = now()
       WHERE id = $1`,
      [
        id,
        next.name,
        next.schedule,
        next.action,
        next.enabled,
        next.lastRunAt ?? null,
        next.sessionId,
        next.tools ? JSON.stringify(next.tools) : null,
      ],
    );
    return this.getTask(id);
  }

  async deleteTask(id: string): Promise<boolean> {
    const result = await this.#pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async addRun(input: Omit<TaskRun, 'id'>): Promise<TaskRun> {
    const id = randomUUID();
    await this.#pool.query(
      `INSERT INTO task_runs (id, task_id, status, output, error, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        input.taskId,
        input.status,
        input.output ?? null,
        input.error ?? null,
        input.startedAt,
        input.finishedAt,
      ],
    );
    return { id, ...input };
  }

  async listRuns(taskId?: string, limit = 50): Promise<TaskRun[]> {
    const result = await this.#pool.query<TaskRunRow>(
      `SELECT id, task_id, status, output, error, started_at, finished_at
       FROM task_runs
       WHERE $1::uuid IS NULL OR task_id = $1
       ORDER BY started_at DESC
       LIMIT $2`,
      [taskId ?? null, limit],
    );
    return result.rows.map(toRun);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
