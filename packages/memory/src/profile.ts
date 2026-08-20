import pg from 'pg';

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
  clear(userId: string): Promise<void>;
}

export class InMemoryProfileStore implements ProfileStore {
  readonly #profiles = new Map<string, UserProfile>();

  async getProfile(userId: string): Promise<UserProfile | null> {
    return this.#profiles.get(userId) ?? null;
  }

  async upsertEntry(
    userId: string,
    entry: Omit<ProfileEntry, 'updatedAt'>,
  ): Promise<UserProfile> {
    const now = new Date().toISOString();
    const existing = this.#profiles.get(userId);
    const entries = (existing?.entries ?? []).filter((item) => item.key !== entry.key);
    entries.push({ ...entry, updatedAt: now });
    const profile: UserProfile = {
      userId,
      entries: entries.sort((a, b) => a.key.localeCompare(b.key)),
      updatedAt: now,
    };
    this.#profiles.set(userId, profile);
    return profile;
  }

  async removeEntry(userId: string, key: string): Promise<UserProfile> {
    const existing = this.#profiles.get(userId);
    const entries = (existing?.entries ?? []).filter((item) => item.key !== key);
    const now = new Date().toISOString();
    const profile: UserProfile = {
      userId,
      entries,
      updatedAt: now,
    };
    this.#profiles.set(userId, profile);
    return profile;
  }

  async replaceAll(
    userId: string,
    entries: Array<Omit<ProfileEntry, 'updatedAt'>>,
  ): Promise<UserProfile> {
    const now = new Date().toISOString();
    const normalized = entries.map((entry) => ({ ...entry, updatedAt: now }));
    normalized.sort((a, b) => a.key.localeCompare(b.key));
    const profile: UserProfile = { userId, entries: normalized, updatedAt: now };
    this.#profiles.set(userId, profile);
    return profile;
  }

  async clear(userId: string): Promise<void> {
    this.#profiles.delete(userId);
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

  constructor(options: PostgresProfileStoreOptions) {
    this.#pool = new Pool({ connectionString: options.connectionString, max: 5 });
  }

  async init(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id text PRIMARY KEY,
        entries jsonb NOT NULL DEFAULT '[]'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
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
    const now = new Date().toISOString();
    const existing = await this.getProfile(userId);
    const entries = (existing?.entries ?? []).filter((item) => item.key !== entry.key);
    entries.push({ ...entry, updatedAt: now });
    entries.sort((a, b) => a.key.localeCompare(b.key));
    await this.#pool.query(
      `INSERT INTO user_profiles (user_id, entries, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (user_id) DO UPDATE SET entries = $2::jsonb, updated_at = $3`,
      [userId, JSON.stringify(entries), now],
    );
    return { userId, entries, updatedAt: now };
  }

  async removeEntry(userId: string, key: string): Promise<UserProfile> {
    const now = new Date().toISOString();
    const existing = await this.getProfile(userId);
    const entries = (existing?.entries ?? []).filter((item) => item.key !== key);
    await this.#pool.query(
      `INSERT INTO user_profiles (user_id, entries, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (user_id) DO UPDATE SET entries = $2::jsonb, updated_at = $3`,
      [userId, JSON.stringify(entries), now],
    );
    return { userId, entries, updatedAt: now };
  }

  async replaceAll(
    userId: string,
    entries: Array<Omit<ProfileEntry, 'updatedAt'>>,
  ): Promise<UserProfile> {
    const now = new Date().toISOString();
    const normalized = entries.map((entry) => ({ ...entry, updatedAt: now }));
    normalized.sort((a, b) => a.key.localeCompare(b.key));
    await this.#pool.query(
      `INSERT INTO user_profiles (user_id, entries, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (user_id) DO UPDATE SET entries = $2::jsonb, updated_at = $3`,
      [userId, JSON.stringify(normalized), now],
    );
    return { userId, entries: normalized, updatedAt: now };
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
