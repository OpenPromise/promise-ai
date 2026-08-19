import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  createLocalEmbedder,
  extractKeywords,
  rrfMerge,
  type Embedder,
  type MemoryEntry,
  type MemoryKind,
  type MemorySearchResult,
  type MemoryStore,
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
  score?: number;
}

function toEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.#pool.query('CREATE INDEX IF NOT EXISTS memories_kind_idx ON memories (kind)');
    await this.#ensureDimensionMatches();
  }

  /**
   * pgvector 列维度固定；当嵌入器维度变化（如本地 384 → 云嵌入 1024）时，
   * 重建 embedding 列并用当前嵌入器重新嵌入存量内容，保留记忆数据。
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

    const rows = await this.#pool.query<MemoryRow>(
      'SELECT id, kind, content FROM memories ORDER BY created_at',
    );
    await this.#pool.query('BEGIN');
    try {
      await this.#pool.query('ALTER TABLE memories DROP COLUMN embedding');
      await this.#pool.query(
        `ALTER TABLE memories ADD COLUMN embedding vector(${this.#dimensions})`,
      );
      for (const row of rows.rows) {
        const vector = await this.#embedder.embed(row.content);
        await this.#pool.query('UPDATE memories SET embedding = $2::vector WHERE id = $1', [
          row.id,
          JSON.stringify(vector),
        ]);
      }
      await this.#pool.query('COMMIT');
    } catch (error) {
      await this.#pool.query('ROLLBACK');
      throw error;
    }
  }

  async add(input: { kind: MemoryKind; content: string }): Promise<MemoryEntry> {
    const id = randomUUID();
    const embedding = await this.#embedder.embed(input.content);
    await this.#pool.query(
      `INSERT INTO memories (id, kind, content, embedding) VALUES ($1, $2, $3, $4::vector)`,
      [id, input.kind, input.content, JSON.stringify(embedding)],
    );
    const entry = await this.#getById(id);
    if (!entry) throw new Error('failed to read back inserted memory');
    return entry;
  }

  async list(kind?: MemoryKind): Promise<MemoryEntry[]> {
    const result = await this.#pool.query<MemoryRow>(
      `SELECT id, kind, content, created_at, updated_at
       FROM memories
       WHERE $1::text IS NULL OR kind = $1
       ORDER BY created_at DESC`,
      [kind ?? null],
    );
    return result.rows.map(toEntry);
  }

  async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
    const embedding = await this.#embedder.embed(query);
    const vectorResult = await this.#pool.query<MemoryRow>(
      `SELECT id, kind, content, created_at, updated_at,
              1 - (embedding <=> $1::vector) AS score
       FROM memories
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [JSON.stringify(embedding), limit * 2],
    );
    // 向量路：保留低阈值候选，排名由 RRF 决定。
    const vectorRows: MemorySearchResult[] = vectorResult.rows
      .filter((row) => (row.score ?? 0) > 0.08)
      .map((row) => ({ entry: toEntry(row), score: row.score ?? 0 }));

    // 关键词路：与向量路独立召回，再经 RRF 融合。
    const keywords = extractKeywords(query);
    const keywordRows: MemorySearchResult[] = [];
    if (keywords.length > 0) {
      const keywordResult = await this.#pool.query<MemoryRow>(
        `SELECT id, kind, content, created_at, updated_at, 0.1 AS score
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
      `SELECT id, kind, content, created_at, updated_at FROM memories WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toEntry(row) : undefined;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
