import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

/**
 * 「她的世界」状态（AI Town world model 单角色版）：
 * - 位置：她当前所在场景（卧室/客厅/书房/阳台…）
 * - 活动：当前在做什么（带 emoji/起止时间），由 WorldService 按时间段推进
 * - 天数/行动计数：证明"她活了一天又一天"
 * 只存状态，活动表与推进逻辑在 agent-server 的 WorldService。
 */

export type WorldActivityKind =
  | 'sleeping'
  | 'working'
  | 'reading'
  | 'eating'
  | 'walking'
  | 'resting'
  | 'chatting'
  | 'custom';

export interface WorldActivity {
  kind: WorldActivityKind;
  label: string;
  emoji: string;
  location: string;
  startedAt: string;
  until: string;
}

export interface AvatarWorldState {
  id: string;
  location: string;
  activity: WorldActivity | null;
  daysLived: number;
  totalActions: number;
  lastTickAt: string;
  updatedAt: string;
}

export function defaultWorldState(): AvatarWorldState {
  const now = new Date().toISOString();
  return {
    id: 'default',
    location: '客厅',
    activity: null,
    daysLived: 0,
    totalActions: 0,
    lastTickAt: now,
    updatedAt: now,
  };
}

export interface WorldStore {
  getWorld(): Promise<AvatarWorldState>;
  saveWorld(state: AvatarWorldState): Promise<AvatarWorldState>;
}

export class InMemoryWorldStore implements WorldStore {
  #state = defaultWorldState();

  async getWorld(): Promise<AvatarWorldState> {
    return structuredClone(this.#state);
  }

  async saveWorld(state: AvatarWorldState): Promise<AvatarWorldState> {
    this.#state = structuredClone(state);
    return this.getWorld();
  }
}

export interface PostgresWorldStoreOptions {
  connectionString: string;
}

export class PostgresWorldStore implements WorldStore {
  readonly #pool: pg.Pool;

  constructor(options: PostgresWorldStoreOptions) {
    this.#pool = new Pool({ connectionString: options.connectionString, max: 5 });
  }

  async init(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS avatar_world (
        id text PRIMARY KEY,
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async getWorld(): Promise<AvatarWorldState> {
    const result = await this.#pool.query<{ state: unknown }>(
      'SELECT state FROM avatar_world WHERE id = $1',
      ['default'],
    );
    if (!result.rows[0]) return defaultWorldState();
    return result.rows[0].state as AvatarWorldState;
  }

  async saveWorld(state: AvatarWorldState): Promise<AvatarWorldState> {
    await this.#pool.query(
      `INSERT INTO avatar_world (id, state, updated_at) VALUES ('default', $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET state = $1::jsonb, updated_at = now()`,
      [JSON.stringify(state)],
    );
    return state;
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
