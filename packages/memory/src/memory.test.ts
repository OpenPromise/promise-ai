import { describe, expect, it, vi } from 'vitest';
import {
  cosineSimilarity,
  createDashScopeEmbedder,
  createLocalEmbedder,
  createResilientEmbedder,
  embedForSearch,
  extractKeywords,
  InMemoryMemoryStore,
  rrfMerge,
} from './memory.js';

describe('createLocalEmbedder + cosineSimilarity', () => {
  it('returns normalized vectors of fixed dimension', async () => {
    const embedder = createLocalEmbedder(64);
    const vector = await embedder.embed('用户喜欢喝美式咖啡');
    expect(vector).toHaveLength(64);
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('ranks similar short texts above unrelated ones', async () => {
    const embedder = createLocalEmbedder();
    const target = await embedder.embed('用户喜欢喝美式咖啡');
    const similar = await embedder.embed('他爱喝美式咖啡');
    const unrelated = await embedder.embed('今天天气很好');
    expect(cosineSimilarity(target, similar)).toBeGreaterThan(cosineSimilarity(target, unrelated));
  });
});

describe('InMemoryMemoryStore', () => {
  it('adds and lists memories with kind filtering', async () => {
    const store = new InMemoryMemoryStore();
    await store.add({ kind: 'semantic', content: '用户喜欢喝美式咖啡' });
    await store.add({ kind: 'episodic', content: '用户开始开发私人 AI 助理' });

    expect(await store.list()).toHaveLength(2);
    expect(await store.list('semantic')).toHaveLength(1);
    expect(await store.list('episodic')).toHaveLength(1);
  });

  it('persists an optional tag on the entry', async () => {
    const store = new InMemoryMemoryStore();
    const goal = await store.add({ kind: 'semantic', content: '[goal] 减肥', tag: 'goal' });
    expect(goal.tag).toBe('goal');

    const feedback = await store.add({
      kind: 'episodic',
      content: '[feedback] 回复太长',
      tag: 'feedback',
    });
    expect(feedback.tag).toBe('feedback');

    const untagged = await store.add({ kind: 'semantic', content: '普通记忆' });
    expect(untagged.tag).toBeUndefined();
    expect((await store.list('semantic')).some((entry) => entry.id === goal.id)).toBe(true);
  });

  it('searches by semantic similarity', async () => {
    const store = new InMemoryMemoryStore();
    await store.add({ kind: 'semantic', content: '用户喜欢喝美式咖啡' });
    await store.add({ kind: 'semantic', content: '用户住在杭州' });

    const results = await store.search('咖啡偏好', 1);
    expect(results).toHaveLength(1);
    expect(results[0]?.entry.content).toContain('美式咖啡');
  });

  it('forget permanently removes an entry', async () => {
    const store = new InMemoryMemoryStore();
    const entry = await store.add({ kind: 'semantic', content: '要删除的记忆' });
    expect(await store.forget(entry.id)).toBe(true);
    expect(await store.list()).toHaveLength(0);
    expect(await store.forget(entry.id)).toBe(false);
  });

  it('edit updates content and returns the entry', async () => {
    const store = new InMemoryMemoryStore();
    const entry = await store.add({ kind: 'semantic', content: '旧内容' });
    const updated = await store.edit(entry.id, '新内容');
    expect(updated?.content).toBe('新内容');
    expect(updated?.updatedAt).toBeDefined();
    expect(await store.edit('missing', 'x')).toBeUndefined();
  });

  it('falls back to keyword matching when vector search finds nothing', async () => {
    // 零向量嵌入器：余弦相似度恒为 0，必然走关键词兜底。
    const zeroEmbedder = {
      dimensions: 8,
      async embed(): Promise<number[]> {
        return [0, 0, 0, 0, 0, 0, 0, 0];
      },
    };
    const store = new InMemoryMemoryStore(zeroEmbedder);
    await store.add({ kind: 'semantic', content: '用户喜欢喝美式咖啡' });
    await store.add({ kind: 'semantic', content: '用户住在杭州' });

    const results = await store.search('咖啡', 2);
    expect(results.some(({ entry }) => entry.content.includes('咖啡'))).toBe(true);
  });

  it('fuses vector and keyword recall with RRF, favoring dual hits', async () => {
    const makeEntry = (id: string, content: string) => ({
      id,
      kind: 'semantic' as const,
      content,
      createdAt: '',
      updatedAt: '',
    });
    const dualHit = makeEntry('dual', '用户喜欢喝美式咖啡，常去杭州');
    const vectorOnly = makeEntry('vector', '用户喜欢咖啡因饮料');
    const keywordOnly = makeEntry('keyword', '杭州的天气很好');

    const merged = rrfMerge(
      [
        [
          { entry: vectorOnly, score: 0.9 },
          { entry: dualHit, score: 0.7 },
        ],
        [
          { entry: keywordOnly, score: 0.1 },
          { entry: dualHit, score: 0.1 },
        ],
      ],
      2,
    );
    expect(merged[0]?.entry.id).toBe('dual');
    expect(merged.map(({ entry }) => entry.id)).toHaveLength(2);
  });
});

describe('createDashScopeEmbedder', () => {
  it('embeds via the OpenAI-compatible embeddings endpoint', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      async json() {
        return { data: [{ embedding: [0.1, 0.2, 0.3] }] };
      },
    })) as unknown as typeof fetch;
    const embedder = createDashScopeEmbedder({
      apiKey: 'sk-test',
      model: 'text-embedding-v4',
      fetchImpl: mockFetch,
    });
    const vector = await embedder.embed('测试');
    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(embedder.dimensions).toBe(1024);
  });

  it('throws a readable error on API failure', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      async json() {
        return { error: { message: 'unauthorized' } };
      },
    })) as unknown as typeof fetch;
    const embedder = createDashScopeEmbedder({
      apiKey: 'sk-test',
      fetchImpl: mockFetch,
    });
    await expect(embedder.embed('测试')).rejects.toThrow('HTTP 401');
  });
});

describe('createResilientEmbedder', () => {
  it('falls back to the local embedder when dimensions match', async () => {
    const failing = {
      dimensions: 8,
      async embed(): Promise<number[]> {
        throw new Error('api down');
      },
    };
    const resilient = createResilientEmbedder(failing, createLocalEmbedder(8));
    const vector = await resilient.embed('回退测试');
    expect(vector).toHaveLength(8);
    expect(vector.some((value) => value !== 0)).toBe(true);
  });

  it('拒绝零填充：备用维度不匹配时抛错而不是写坏向量', async () => {
    const failing = {
      dimensions: 1024,
      async embed(): Promise<number[]> {
        throw new Error('api down');
      },
    };
    const resilient = createResilientEmbedder(failing, createLocalEmbedder(8));
    await expect(resilient.embed('回退测试')).rejects.toThrow('维度不匹配');
  });
});

describe('embedForSearch', () => {
  it('嵌入失败时返回 null，让检索退化为关键词路', async () => {
    const failing = {
      dimensions: 1024,
      async embed(): Promise<number[]> {
        throw new Error('api down');
      },
    };
    await expect(embedForSearch(failing, '查询')).resolves.toBeNull();
  });

  it('嵌入成功时直接返回向量', async () => {
    await expect(embedForSearch(createLocalEmbedder(8), '查询')).resolves.toHaveLength(8);
  });
});

describe('extractKeywords', () => {
  it('extracts CJK bigrams and latin words', () => {
    expect(extractKeywords('用户喜欢喝咖啡')).toContain('咖啡');
    expect(extractKeywords('remember the meeting')).toContain('remember');
  });
});
