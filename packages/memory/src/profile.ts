import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;

/**
 * 结构化用户画像：跨会话记住用户的事实 / 偏好 / 习惯 / 语气倾向，
 * 每次对话注入系统提示（用户画像块），让 AI 持续了解主人
 * （JARVIS 式长期关系记忆，区别于关键词检索的 episodic 记忆）。
 */

export type ProfileCategory = 'fact' | 'preference' | 'habit' | 'tone';

export interface ProfileEntry {
  key: string;
  value: string;
  category: ProfileCategory;
  updatedAt: string;
}

export interface UserProfile {
  userId: string;
  entries: ProfileEntry[];
  updatedAt: string;
}

export type ProfileEventType = 'ADD' | 'UPDATE' | 'DELETE';

export interface ProfileEvent {
  id: string;
  userId: string;
  key: string;
  category: ProfileCategory;
  event: ProfileEventType;
  oldValue?: string;
  newValue?: string;
  createdAt: string;
}

export interface ProfileStore {
  getProfile(userId: string): Promise<UserProfile | null>;
  /** 按 key 覆盖写入（key 唯一），返回最新画像。 */
  upsertEntry(
    userId: string,
    entry: Omit<ProfileEntry, 'updatedAt'>,
  ): Promise<UserProfile>;
  /** 删除某个 key；不存在时返回当前画像。 */
  removeEntry(userId: string, key: string): Promise<UserProfile>;
  /** 整表替换（画像整理/压缩用）。 */
  replaceAll(
    userId: string,
    entries: Array<Omit<ProfileEntry, 'updatedAt'>>,
  ): Promise<UserProfile>;
  /** 变更历史（新→旧）。key 省略则返回全部；limit 限制条数。 */
  listHistory(
    userId: string,
    options?: { key?: string; limit?: number },
  ): Promise<ProfileEvent[]>;
  /**
   * 回滚某个 key：toEventId 指定恢复到某次事件后的状态；
   * 省略则撤销该 key 最近一次修改。回滚本身也会记录一条新事件。
   */
  rollbackEntry(
    userId: string,
    key: string,
    options?: { toEventId?: string },
  ): Promise<UserProfile>;
  clear(userId: string): Promise<void>;
}

/**
 * 计算回滚目标（events 新→旧）：
 * - 指定 toEventId：恢复到"不晚于该事件"的最新状态
 * - 省略：撤销最近一次修改（回到上一条事件建立的状态）
 * 返回 { value, category }（恢复值）或 { deleted }（删除该 key）或 null（无历史）。
 */
export function resolveRollbackTarget(
  events: ProfileEvent[],
  toEventId?: string,
): { value: string; category: ProfileCategory } | { deleted: true } | null {
  if (events.length === 0) return null;
  let anchor: ProfileEvent;
  if (toEventId) {
    const idx = events.findIndex((event) => event.id === toEventId);
    if (idx === -1) return null;
    anchor = events[idx]!;
  } else {
    // 撤销最近一次：目标是"最近一次事件之前"的状态（倒数第二条建立的状态）
    anchor = events[1]!;
    if (!anchor) {
      return events[0]!.event === 'ADD' ? { deleted: true } : null;
    }
  }
  if (anchor.event === 'DELETE') return { deleted: true };
  return { value: anchor.newValue ?? '', category: anchor.category };
}

function eventFromDiff(
  userId: string,
  oldEntry: ProfileEntry | undefined,
  newEntry: Omit<ProfileEntry, 'updatedAt'>,
): Omit<ProfileEvent, 'id' | 'createdAt'> | null {
  if (!oldEntry) {
    return {
      userId,
      key: newEntry.key,
      category: newEntry.category,
      event: 'ADD',
      newValue: newEntry.value,
    };
  }
  if (oldEntry.value === newEntry.value && oldEntry.category === newEntry.category) {
    return null; // 无变化，不记录事件
  }
  return {
    userId,
    key: newEntry.key,
    category: newEntry.category,
    event: 'UPDATE',
    oldValue: oldEntry.value,
    newValue: newEntry.value,
  };
}

export class InMemoryProfileStore implements ProfileStore {
  readonly #profiles = new Map<string, UserProfile>();
  readonly #events = new Map<string, ProfileEvent[]>();

  #record(userId: string, event: Omit<ProfileEvent, 'id' | 'createdAt'>): void {
    const events = this.#events.get(userId) ?? [];
    events.push({ ...event, id: randomUUID(), createdAt: new Date().toISOString() });
    this.#events.set(userId, events);
  }

  async getProfile(userId: string): Promise<UserProfile | null> {
    return this.#profiles.get(userId) ?? null;
  }

  async upsertEntry(
    userId: string,
    entry: Omit<ProfileEntry, 'updatedAt'>,
  ): Promise<UserProfile> {
    const now = new Date().toISOString();
    const existing = this.#profiles.get(userId);
    const oldEntry = existing?.entries.find((item) => item.key === entry.key);
    const diff = eventFromDiff(userId, oldEntry, entry);
    const entries = (existing?.entries ?? []).filter((item) => item.key !== entry.key);
    entries.push({ ...entry, updatedAt: now });
    const profile: UserProfile = {
      userId,
      entries: entries.sort((a, b) => a.key.localeCompare(b.key)),
      updatedAt: now,
    };
    this.#profiles.set(userId, profile);
    if (diff) this.#record(userId, diff);
    return profile;
  }

  async removeEntry(userId: string, key: string): Promise<UserProfile> {
    const existing = this.#profiles.get(userId);
    const oldEntry = existing?.entries.find((item) => item.key === key);
    const entries = (existing?.entries ?? []).filter((item) => item.key !== key);
    const now = new Date().toISOString();
    const profile: UserProfile = {
      userId,
      entries,
      updatedAt: now,
    };
    this.#profiles.set(userId, profile);
    if (oldEntry) {
      this.#record(userId, {
        userId,
        key,
        category: oldEntry.category,
        event: 'DELETE',
        oldValue: oldEntry.value,
      });
    }
    return profile;
  }

  async replaceAll(
    userId: string,
    entries: Array<Omit<ProfileEntry, 'updatedAt'>>,
  ): Promise<UserProfile> {
    const now = new Date().toISOString();
    const normalized = entries.map((entry) => ({ ...entry, updatedAt: now }));
    normalized.sort((a, b) => a.key.localeCompare(b.key));
    const oldEntries = this.#profiles.get(userId)?.entries ?? [];
    const profile: UserProfile = { userId, entries: normalized, updatedAt: now };
    this.#profiles.set(userId, profile);
    const oldByKey = new Map(oldEntries.map((entry) => [entry.key, entry]));
    const newByKey = new Map(normalized.map((entry) => [entry.key, entry]));
    for (const [key, oldEntry] of oldByKey) {
      if (!newByKey.has(key)) {
        this.#record(userId, {
          userId,
          key,
          category: oldEntry.category,
          event: 'DELETE',
          oldValue: oldEntry.value,
        });
      }
    }
    for (const newEntry of normalized) {
      const diff = eventFromDiff(userId, oldByKey.get(newEntry.key), newEntry);
      if (diff) this.#record(userId, diff);
    }
    return profile;
  }

  async listHistory(
    userId: string,
    options: { key?: string; limit?: number } = {},
  ): Promise<ProfileEvent[]> {
    const events = this.#events.get(userId) ?? [];
    const filtered = options.key
      ? events.filter((event) => event.key === options.key)
      : events;
    const limited = options.limit ? filtered.slice(-options.limit) : filtered;
    return [...limited].reverse();
  }

  async rollbackEntry(
    userId: string,
    key: string,
    options: { toEventId?: string } = {},
  ): Promise<UserProfile> {
    const history = await this.listHistory(userId, { key });
    const target = resolveRollbackTarget(history, options.toEventId);
    if (!target) {
      const profile = this.#profiles.get(userId);
      return profile ?? { userId, entries: [], updatedAt: new Date().toISOString() };
    }
    if ('deleted' in target) {
      return this.removeEntry(userId, key);
    }
    return this.upsertEntry(userId, {
      key,
      value: target.value,
      category: target.category,
    });
  }

  async clear(userId: string): Promise<void> {
    this.#profiles.delete(userId);
    this.#events.delete(userId);
  }
}

export interface PostgresProfileStoreOptions {
  connectionString: string;
}

interface ProfileRow {
  user_id: string;
  entries: unknown;
  updated_at: string;
}

interface ProfileEventRow {
  id: string;
  user_id: string;
  key: string;
  category: string;
  event: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

function parseEntries(raw: unknown): ProfileEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null && typeof item.key === 'string',
    )
    .map((item) => ({
      key: item.key as string,
      value: typeof item.value === 'string' ? item.value : '',
      category: ['fact', 'preference', 'habit', 'tone'].includes(String(item.category))
        ? (item.category as ProfileCategory)
        : 'fact',
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    }));
}

/** 用户画像 Postgres 存储：单行 JSONB（单用户场景足够简单）。 */
export class PostgresProfileStore implements ProfileStore {
  readonly #pool: pg.Pool;
  /**
   * 用户级串行队列：同一用户的读-改-写串行执行。entries 是单行 JSONB，
   * "先读整列→内存改→整列覆盖"在并发写时（画像工具 + 对话后异步抽取）会
   * 丢失更新，这里在进程内把每个 userId 的写串行化，后写者基于前写者结果。
   */
  readonly #userQueues = new Map<string, Promise<unknown>>();

  constructor(options: PostgresProfileStoreOptions) {
    this.#pool = new Pool({ connectionString: options.connectionString, max: 5 });
  }

  /** 把 fn 串行进同一 userId 的队列；队列空时自动清理条目避免 Map 无限增长。 */
  async #runExclusive<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#userQueues.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => gate);
    this.#userQueues.set(userId, chain);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#userQueues.get(userId) === chain) {
        this.#userQueues.delete(userId);
      }
    }
  }

  async init(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id text PRIMARY KEY,
        entries jsonb NOT NULL DEFAULT '[]'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS profile_events (
        id uuid PRIMARY KEY,
        user_id text NOT NULL,
        key text NOT NULL,
        category text NOT NULL,
        event text NOT NULL CHECK (event IN ('ADD', 'UPDATE', 'DELETE')),
        old_value text,
        new_value text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.#pool.query(
      'CREATE INDEX IF NOT EXISTS profile_events_user_key_idx ON profile_events (user_id, key, created_at)',
    );
  }

  async #record(userId: string, event: Omit<ProfileEvent, 'id' | 'createdAt'>): Promise<void> {
    await this.#pool.query(
      `INSERT INTO profile_events (id, user_id, key, category, event, old_value, new_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        userId,
        event.key,
        event.category,
        event.event,
        event.oldValue ?? null,
        event.newValue ?? null,
      ],
    );
  }

  async #recordDiff(
    userId: string,
    oldEntry: ProfileEntry | undefined,
    newEntry: Omit<ProfileEntry, 'updatedAt'>,
  ): Promise<void> {
    const diff = eventFromDiff(userId, oldEntry, newEntry);
    if (diff) await this.#record(userId, diff);
  }

  async getProfile(userId: string): Promise<UserProfile | null> {
    const result = await this.#pool.query<ProfileRow>(
      'SELECT user_id, entries, updated_at FROM user_profiles WHERE user_id = $1',
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      entries: parseEntries(row.entries),
      updatedAt: row.updated_at,
    };
  }

  async upsertEntry(
    userId: string,
    entry: Omit<ProfileEntry, 'updatedAt'>,
  ): Promise<UserProfile> {
    return this.#runExclusive(userId, async () => {
      const now = new Date().toISOString();
      const existing = await this.getProfile(userId);
      const oldEntry = existing?.entries.find((item) => item.key === entry.key);
      const entries = (existing?.entries ?? []).filter((item) => item.key !== entry.key);
      entries.push({ ...entry, updatedAt: now });
      entries.sort((a, b) => a.key.localeCompare(b.key));
      await this.#pool.query(
        `INSERT INTO user_profiles (user_id, entries, updated_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (user_id) DO UPDATE SET entries = $2::jsonb, updated_at = $3`,
        [userId, JSON.stringify(entries), now],
      );
      await this.#recordDiff(userId, oldEntry, entry);
      return { userId, entries, updatedAt: now };
    });
  }

  async removeEntry(userId: string, key: string): Promise<UserProfile> {
    return this.#runExclusive(userId, async () => {
      const now = new Date().toISOString();
      const existing = await this.getProfile(userId);
      const oldEntry = existing?.entries.find((item) => item.key === key);
      const entries = (existing?.entries ?? []).filter((item) => item.key !== key);
      await this.#pool.query(
        `INSERT INTO user_profiles (user_id, entries, updated_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (user_id) DO UPDATE SET entries = $2::jsonb, updated_at = $3`,
        [userId, JSON.stringify(entries), now],
      );
      if (oldEntry) {
        await this.#record(userId, {
          userId,
          key,
          category: oldEntry.category,
          event: 'DELETE',
          oldValue: oldEntry.value,
        });
      }
      return { userId, entries, updatedAt: now };
    });
  }

  async replaceAll(
    userId: string,
    entries: Array<Omit<ProfileEntry, 'updatedAt'>>,
  ): Promise<UserProfile> {
    return this.#runExclusive(userId, async () => {
      const now = new Date().toISOString();
      const normalized = entries.map((entry) => ({ ...entry, updatedAt: now }));
      normalized.sort((a, b) => a.key.localeCompare(b.key));
      const existing = await this.getProfile(userId);
      await this.#pool.query(
        `INSERT INTO user_profiles (user_id, entries, updated_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (user_id) DO UPDATE SET entries = $2::jsonb, updated_at = $3`,
        [userId, JSON.stringify(normalized), now],
      );
      const oldByKey = new Map((existing?.entries ?? []).map((entry) => [entry.key, entry]));
      const newByKey = new Map(normalized.map((entry) => [entry.key, entry]));
      for (const [key, oldEntry] of oldByKey) {
        if (!newByKey.has(key)) {
          await this.#record(userId, {
            userId,
            key,
            category: oldEntry.category,
            event: 'DELETE',
            oldValue: oldEntry.value,
          });
        }
      }
      for (const newEntry of normalized) {
        await this.#recordDiff(userId, oldByKey.get(newEntry.key), newEntry);
      }
      return { userId, entries: normalized, updatedAt: now };
    });
  }

  async listHistory(
    userId: string,
    options: { key?: string; limit?: number } = {},
  ): Promise<ProfileEvent[]> {
    const params: unknown[] = [userId];
    let sql = 'SELECT id, user_id, key, category, event, old_value, new_value, created_at FROM profile_events WHERE user_id = $1';
    if (options.key) {
      params.push(options.key);
      sql += ` AND key = $${params.length}`;
    }
    sql += ' ORDER BY created_at DESC, id DESC';
    if (options.limit) {
      params.push(options.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const result = await this.#pool.query<ProfileEventRow>(sql, params);
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      key: row.key,
      category: (row.category as ProfileCategory) || 'fact',
      event: row.event as ProfileEventType,
      ...(row.old_value !== null ? { oldValue: row.old_value } : {}),
      ...(row.new_value !== null ? { newValue: row.new_value } : {}),
      createdAt: row.created_at,
    }));
  }

  async rollbackEntry(
    userId: string,
    key: string,
    options: { toEventId?: string } = {},
  ): Promise<UserProfile> {
    const history = await this.listHistory(userId, { key });
    const target = resolveRollbackTarget(history, options.toEventId);
    if (!target) {
      const profile = await this.getProfile(userId);
      return profile ?? { userId, entries: [], updatedAt: new Date().toISOString() };
    }
    if ('deleted' in target) {
      return this.removeEntry(userId, key);
    }
    return this.upsertEntry(userId, {
      key,
      value: target.value,
      category: target.category,
    });
  }

  async clear(userId: string): Promise<void> {
    await this.#pool.query('DELETE FROM user_profiles WHERE user_id = $1', [userId]);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

export function createProfileStoreId(userId?: string): string {
  return userId ?? 'default';
}

export const PROFILE_DEFAULT_USER_ID = 'default';

/** 供 profile 工具生成稳定 userId（当前单用户场景恒为 default）。 */
export function resolveProfileUserId(userId?: string): string {
  return userId?.trim() ? userId.trim() : PROFILE_DEFAULT_USER_ID;
}
