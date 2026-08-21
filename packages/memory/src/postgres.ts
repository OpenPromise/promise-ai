import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  createLocalEmbedder,
  embedForSearch,
  extractKeywords,
  rrfMerge,
  type Embedder,
  type MemoryEntry,
  type MemoryKind,
  type MemorySearchResult,
  type MemoryStore,
  type MemoryTag,
} from './memory.js';

const { Pool } = pg;

export interface PostgresMemoryStoreOptions {
  connectionString: string;
  embedder?: Embedder;
  dimensions?: number;
}

interface MemoryRow {
  id: string;
  kind: MemoryKind;
  content: string;
  created_at: string;
  updated_at: string;
  tag?: MemoryTag | null;
  score?: number;
}

function toEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.tag ? { tag: row.tag } : {}),
  };
}

/**
 * PostgreSQL + pgvector memory store. Falls back to the injected embedder for
 * vector generation; cosine distance (`<=>`) drives semantic search.
 */
export class PostgresMemoryStore implements MemoryStore {
  readonly #pool: pg.Pool;
  readonly #embedder: Embedder;
  readonly #dimensions: number;

  constructor(options: PostgresMemoryStoreOptions) {
    this.#pool = new Pool({ connectionString: options.connectionString, max: 5 });
    this.#embedder = options.embedder ?? createLocalEmbedder(options.dimensions);
    this.#dimensions = options.dimensions ?? this.#embedder.dimensions ?? 384;
  }

  async init(): Promise<void> {
    await this.#pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id uuid PRIMARY KEY,
        kind text NOT NULL CHECK (kind IN ('episodic', 'semantic')),
        content text NOT NULL,
        embedding vector(${this.#dimensions}),
        tag text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // 幂等迁移：已存在的旧表没有 tag 列（CREATE TABLE IF NOT EXISTS 不会加列）
    await this.#pool.query('ALTER TABLE memories ADD COLUMN IF NOT EXISTS tag text');
    await this.#pool.query('CREATE INDEX IF NOT EXISTS memories_kind_idx ON memories (kind)');
    await this.#ensureDimensionMatches();
  }

  /**
   * pgvector 列维度固定；当嵌入器维度变化（如本地 384 → 云嵌入 1024）时，
   * 重建 embedding 列并用当前嵌入器重新嵌入存量内容，保留记忆数据。
   * 迁移必须落在同一连接上才是真事务（pool.query 每次可能换连接），
   * 失败时回滚并抛错阻止启动——绝不能留下"已 DROP 又未回填"的空向量列。
   */
  async #ensureDimensionMatches(): Promise<void> {
    const dimResult = await this.#pool.query<{ atttypmod: number | null }>(
      `SELECT atttypmod FROM pg_attribute
       WHERE attrelid = 'memories'::regclass AND attname = 'embedding'`,
    );
    const typmod = dimResult.rows[0]?.atttypmod;
    if (typmod == null) return;
    const currentDim = typmod - 4;
    if (currentDim === this.#dimensions) return;

    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // 行快照必须在同一事务连接上取（N-P2-3）：BEGIN 前的快照与 DDL 后状态不一致
      const rows = await client.query<MemoryRow>(
        'SELECT id, kind, content FROM memories ORDER BY created_at',
      );
      await client.query('ALTER TABLE memories DROP COLUMN embedding');
      await client.query(`ALTER TABLE memories ADD COLUMN embedding vector(${this.#dimensions})`);
      for (const row of rows.rows) {
        const vector = await this.#embedder.embed(row.content);
        await client.query('UPDATE memories SET embedding = $2::vector WHERE id = $1', [
          row.id,
          JSON.stringify(vector),
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // 连接已失效时 ROLLBACK 会失败；原始错误更重要，继续抛它。
      }
      throw new Error(
        `记忆向量维度迁移失败（${currentDim} → ${this.#dimensions}），已回滚：` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      client.release();
    }
  }

  async add(input: { kind: MemoryKind; content: string; tag?: MemoryTag }): Promise<MemoryEntry> {
    const id = randomUUID();
    const embedding = await this.#embedder.embed(input.content);
    await this.#pool.query(
      `INSERT INTO memories (id, kind, content, embedding, tag) VALUES ($1, $2, $3, $4::vector, $5)`,
      [id, input.kind, input.content, JSON.stringify(embedding), input.tag ?? null],
    );
    const entry = await this.#getById(id);
    if (!entry) throw new Error('failed to read back inserted memory');
    return entry;
  }

  async list(kind?: MemoryKind, options?: { limit?: number }): Promise<MemoryEntry[]> {
    const limit = Math.min(Math.max(1, Math.floor(options?.limit ?? 200)), 1000);
    const result = await this.#pool.query<MemoryRow>(
      `SELECT id, kind, content, tag, created_at, updated_at
       FROM memories
       WHERE $1::text IS NULL OR kind = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [kind ?? null, limit],
    );
    return result.rows.map(toEntry);
  }

  async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
    // 检索侧嵌入失败不应让整轮对话失败：退化为纯关键词路（见 embedForSearch）。
    const embedding = await embedForSearch(this.#embedder, query);
    const vectorRows: MemorySearchResult[] = [];
    if (embedding) {
      const vectorResult = await this.#pool.query<MemoryRow>(
        `SELECT id, kind, content, tag, created_at, updated_at,
                1 - (embedding <=> $1::vector) AS score
         FROM memories
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [JSON.stringify(embedding), limit * 2],
      );
      // 向量路：保留低阈值候选，排名由 RRF 决定。
      vectorRows.push(
        ...vectorResult.rows
          .filter((row) => (row.score ?? 0) > 0.08)
          .map((row) => ({ entry: toEntry(row), score: row.score ?? 0 })),
      );
    }

    // 关键词路：与向量路独立召回，再经 RRF 融合。
    const keywords = extractKeywords(query);
    const keywordRows: MemorySearchResult[] = [];
    if (keywords.length > 0) {
      const keywordResult = await this.#pool.query<MemoryRow>(
        `SELECT id, kind, content, tag, created_at, updated_at, 0.1 AS score
         FROM memories
         WHERE content ILIKE ANY($1)
         ORDER BY updated_at DESC
         LIMIT $2`,
        [keywords.map((keyword) => `%${escapeLike(keyword)}%`), limit * 2],
      );
      keywordRows.push(...keywordResult.rows.map((row) => ({ entry: toEntry(row), score: 0.1 })));
    }
    return rrfMerge([vectorRows, keywordRows], limit);
  }

  async forget(id: string): Promise<boolean> {
    const result = await this.#pool.query('DELETE FROM memories WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async edit(id: string, content: string): Promise<MemoryEntry | undefined> {
    const embedding = await this.#embedder.embed(content);
    await this.#pool.query(
      `UPDATE memories SET content = $2, embedding = $3::vector, updated_at = now() WHERE id = $1`,
      [id, content, JSON.stringify(embedding)],
    );
    return this.#getById(id);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #getById(id: string): Promise<MemoryEntry | undefined> {
    const result = await this.#pool.query<MemoryRow>(
      `SELECT id, kind, content, tag, created_at, updated_at FROM memories WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toEntry(row) : undefined;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
