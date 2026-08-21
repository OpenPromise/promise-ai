import { randomUUID } from 'node:crypto';

export type MemoryKind = 'episodic' | 'semantic';

/** 结构化记忆标签：让"注入过滤"不再依赖 content 字符串前缀（旧数据仍走前缀回退）。 */
export type MemoryTag = 'goal' | 'feedback';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  createdAt: string;
  updatedAt: string;
  /** 可选标签（goal/feedback 等），由写入方显式打标。 */
  tag?: MemoryTag;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface Embedder {
  embed(text: string): Promise<number[]>;
  /** 输出向量维度；缺失时由存储层决定（默认 384）。 */
  readonly dimensions?: number;
}

export interface MemoryStore {
  add(input: { kind: MemoryKind; content: string; tag?: MemoryTag }): Promise<MemoryEntry>;
  /** 按类型列出记忆，可按时间倒序限量（避免每轮对话全表扫描）。 */
  list(kind?: MemoryKind, options?: { limit?: number }): Promise<MemoryEntry[]>;
  search(query: string, limit?: number): Promise<MemorySearchResult[]>;
  /** Permanently deletes a memory entry. */
  forget(id: string): Promise<boolean>;
  edit(id: string, content: string): Promise<MemoryEntry | undefined>;
  close?(): Promise<void>;
}

/**
 * Deterministic, dependency-free embedder: character bigram hashing into a
 * fixed-size normalized vector. Good enough for short Chinese memory snippets;
 * swap in a real embedding API later without touching the stores.
 */
export function createLocalEmbedder(dimensions = 384): Embedder {
  return {
    dimensions,
    async embed(text: string): Promise<number[]> {
      const vector = new Float32Array(dimensions);
      const normalized = text.toLowerCase();
      for (let i = 0; i < normalized.length - 1; i++) {
        const gram = normalized.slice(i, i + 2);
        let hash = 0;
        for (let j = 0; j < gram.length; j++) {
          hash = (hash * 31 + gram.charCodeAt(j)) >>> 0;
        }
        const index = hash % dimensions;
        vector[index] = (vector[index] ?? 0) + 1;
      }

      let norm = 0;
      for (const value of vector) norm += value * value;
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < vector.length; i++) {
          vector[i] = (vector[i] ?? 0) / norm;
        }
      }
      return [...vector];
    },
  };
}

export interface DashScopeEmbedderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** 单次请求超时（毫秒），默认 30s：云接口挂起时不能拖死整条对话链路。 */
  timeoutMs?: number;
  /** 可注入的 fetch（测试用）；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/**
 * 百炼（DashScope）text-embedding 云嵌入器：中文语义检索质量远好于本地
 * bigram 哈希。OpenAI 兼容接口：POST {base}/embeddings。
 */
export function createDashScopeEmbedder(options: DashScopeEmbedderOptions): Embedder {
  const model = options.model ?? process.env.QWEN_EMBEDDING_MODEL ?? 'text-embedding-v4';
  const baseUrl = (options.baseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(
    /\/+$/,
    '',
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    dimensions: 1024,
    async embed(text: string): Promise<number[]> {
      if (!options.apiKey) {
        throw new Error('DASHSCOPE_API_KEY 未配置，无法使用云嵌入');
      }
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model, input: [text] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // AbortSignal.timeout 触发时是 TimeoutError；统一成可读错误交给上层降级。
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`DashScope embeddings 请求失败（超时 ${timeoutMs}ms 或网络错误）：${reason}`);
      }
      const data = (await response.json()) as {
        data?: Array<{ embedding?: number[] }>;
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(
          `DashScope embeddings 调用失败（HTTP ${response.status}）：${data.error?.message ?? ''}`,
        );
      }
      const embedding = data.data?.[0]?.embedding;
      if (!embedding) {
        throw new Error('DashScope embeddings 返回为空');
      }
      return embedding;
    },
  };
}

/**
 * 主嵌入器失败时回退到备用嵌入器——仅当备用维度与主维度一致时才可回退。
 * 维度不一致时**必须抛错**：过去的"补零到主维度"会把语义空间完全不同的
 * 假向量写进同一个 pgvector 列，检索结果静默失真且只能靠重嵌入修复。
 * 写入失败要显式失败，检索侧由 store 退化为关键词路兜底。
 */
export function createResilientEmbedder(primary: Embedder, fallback: Embedder): Embedder {
  const dimensions = primary.dimensions ?? fallback.dimensions ?? 384;
  return {
    dimensions,
    async embed(text: string): Promise<number[]> {
      try {
        return await primary.embed(text);
      } catch (error) {
        const vector = await fallback.embed(text);
        if (vector.length === dimensions) return vector;
        throw new Error(
          `云嵌入失败且备用嵌入器维度不匹配（${vector.length} ≠ ${dimensions}），` +
            `拒绝写入以避免污染向量库：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    },
  };
}

/**
 * 检索用嵌入：失败时返回 null，让 store 退化为关键词检索。
 * 写入路径不使用本函数——写入失败必须显式抛错（见 createResilientEmbedder）。
 */
export async function embedForSearch(embedder: Embedder, query: string): Promise<number[] | null> {
  try {
    return await embedder.embed(query);
  } catch (error) {
    console.warn(
      `[memory] 向量检索不可用，本次退化为关键词检索：${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** 从查询里提取关键词（CJK 用二元组），供向量检索无结果时的关键词兜底。 */
export function extractKeywords(query: string): string[] {
  const keywords: string[] = [];
  const cjk = query.replace(/[^\u4e00-\u9fff]/g, '');
  if (cjk.length >= 2) {
    for (let i = 0; i < cjk.length - 1 && keywords.length < 6; i++) {
      keywords.push(cjk.slice(i, i + 2));
    }
  }
  for (const word of query.split(/[\s\p{P}\p{S}]+/u)) {
    const trimmed = word.trim();
    if (trimmed.length < 2) continue;
    // 纯中文词已由上面的二元组覆盖，避免整句被当作单个关键词。
    if (/^[\u4e00-\u9fff]+$/.test(trimmed)) continue;
    keywords.push(trimmed);
  }
  return [...new Set(keywords)].slice(0, 6);
}

function containsKeyword(content: string, keywords: string[]): boolean {
  const lower = content.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * RRF（Reciprocal Rank Fusion）：把多路召回结果按排名加权融合，同一记忆在
 * 多路同时命中会获得更高分。OpenCrabs 混合检索思路：向量 + 关键词双路召回
 * 不再"向量优先、关键词兜底"，而是平等融合。
 */
export function rrfMerge(
  lists: Array<Array<MemorySearchResult>>,
  limit: number,
  k = 60,
): MemorySearchResult[] {
  const merged = new Map<string, { score: number; entry: MemoryEntry }>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      if (!item) continue;
      const contribution = 1 / (k + rank + 1);
      const current = merged.get(item.entry.id);
      if (current) {
        current.score += contribution;
      } else {
        merged.set(item.entry.id, { score: contribution, entry: item.entry });
      }
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, entry }) => ({ entry, score }));
}

export class InMemoryMemoryStore implements MemoryStore {
  readonly #items: MemoryEntry[] = [];
  readonly #embedder: Embedder;
  /** id -> 向量缓存：云嵌入器下避免每次搜索都重复调用 API。 */
  readonly #vectors = new Map<string, number[]>();

  constructor(embedder: Embedder = createLocalEmbedder()) {
    this.#embedder = embedder;
  }

  async add(input: { kind: MemoryKind; content: string; tag?: MemoryTag }): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: randomUUID(),
      kind: input.kind,
      content: input.content,
      createdAt: now,
      updatedAt: now,
      ...(input.tag ? { tag: input.tag } : {}),
    };
    this.#items.push(entry);
    this.#vectors.set(entry.id, await this.#embedder.embed(entry.content));
    return entry;
  }

  async list(kind?: MemoryKind, options?: { limit?: number }): Promise<MemoryEntry[]> {
    const entries = this.#items
      .filter((entry) => !kind || entry.kind === kind)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return options?.limit !== undefined ? entries.slice(0, options.limit) : entries;
  }

  async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
    if (this.#items.length === 0) return [];
    // 检索侧嵌入失败不应让整轮对话失败：退化为纯关键词路（见 embedForSearch）。
    const queryVector = await embedForSearch(this.#embedder, query);
    const results: MemorySearchResult[] = [];
    if (queryVector) {
      for (const entry of this.#items) {
        let vector = this.#vectors.get(entry.id);
        if (!vector) {
          const embedded = await embedForSearch(this.#embedder, entry.content);
          if (!embedded) continue;
          vector = embedded;
          this.#vectors.set(entry.id, vector);
        }
        results.push({ entry, score: cosineSimilarity(queryVector, vector) });
      }
    }
    // 向量路：保留低阈值候选，排名由 RRF 决定。
    const vectorResults: MemorySearchResult[] = results
      .filter((result) => result.score > 0.08)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit * 2);

    // 关键词路：与向量路独立召回，再经 RRF 融合。
    const keywords = extractKeywords(query);
    const keywordHits: MemorySearchResult[] = [];
    if (keywords.length > 0) {
      for (const entry of this.#items) {
        if (keywordHits.length >= limit * 2) break;
        if (containsKeyword(entry.content, keywords)) {
          keywordHits.push({ entry, score: 0.1 });
        }
      }
    }
    return rrfMerge([vectorResults, keywordHits], limit);
  }

  async forget(id: string): Promise<boolean> {
    const index = this.#items.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    this.#items.splice(index, 1);
    this.#vectors.delete(id);
    return true;
  }

  async edit(id: string, content: string): Promise<MemoryEntry | undefined> {
    const entry = this.#items.find((item) => item.id === id);
    if (!entry) return undefined;
    entry.content = content;
    entry.updatedAt = new Date().toISOString();
    this.#vectors.set(entry.id, await this.#embedder.embed(content));
    return { ...entry };
  }
}
