import { describe, expect, it, vi } from 'vitest';
import type { GenerateResult, LLMProvider } from '@personal-ai/llm';
import { InMemoryProfileStore } from '@personal-ai/memory';
import {
  applyExtractedFacts,
  buildExtractionPrompt,
  parseExtractionResponse,
  ProfileIngestor,
} from './profile-ingestor.js';

function fakeLlm(text: string): LLMProvider {
  return {
    name: 'fake',
    model: 'test',
    configured: true,
    async *chat() {
      yield { delta: text };
    },
    async generate(): Promise<GenerateResult> {
      return { text };
    },
  };
}

describe('parseExtractionResponse', () => {
  it('解析纯 JSON', () => {
    const facts = parseExtractionResponse(
      '{"facts":[{"key":"name","value":"夜夜","category":"fact","event":"ADD"}]}',
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ key: 'name', value: '夜夜', event: 'ADD' });
  });

  it('容忍 markdown 代码块与多余文字', () => {
    const facts = parseExtractionResponse(
      '好的，这是结果：\n```json\n{"facts":[{"key":"作息","value":"夜猫子","category":"habit","event":"UPDATE"}]}\n```\n完成',
    );
    expect(facts[0]?.key).toBe('作息');
    expect(facts[0]?.event).toBe('UPDATE');
  });

  it('非法/空输出返回空数组', () => {
    expect(parseExtractionResponse('没有可提取的内容')).toEqual([]);
    expect(parseExtractionResponse('{"facts":[]}')).toEqual([]);
  });
});

describe('applyExtractedFacts', () => {
  it('ADD/UPDATE 覆盖写、DELETE 删除、NONE 跳过', async () => {
    const store = new InMemoryProfileStore();
    await store.upsertEntry('default', { key: 'name', value: '旧名', category: 'fact' });
    await applyExtractedFacts(store, 'default', [
      { key: 'name', value: '夜夜', category: 'fact', event: 'UPDATE' },
      { key: '口味', value: '辣', category: 'preference', event: 'ADD' },
      { key: '旧条目', value: 'x', category: 'fact', event: 'DELETE' },
      { key: '重复', value: 'y', category: 'fact', event: 'NONE' },
    ]);
    const profile = await store.getProfile('default');
    const entries = profile?.entries ?? [];
    expect(entries.find((e) => e.key === 'name')?.value).toBe('夜夜');
    expect(entries.find((e) => e.key === '口味')).toBeDefined();
    expect(entries.find((e) => e.key === '旧条目')).toBeUndefined();
    expect(entries.find((e) => e.key === '重复')).toBeUndefined();
  });
});

describe('ProfileIngestor', () => {
  it('对话后自动抽取并写回画像', async () => {
    const store = new InMemoryProfileStore();
    const llm = fakeLlm(
      '{"facts":[{"key":"name","value":"夜夜","category":"fact","event":"ADD"}]}',
    );
    const ingestor = new ProfileIngestor({ llm, store, minIntervalMs: 0 });
    await ingestor.ingest('我叫夜夜，请记住');
    const profile = await store.getProfile('default');
    expect(profile?.entries.find((e) => e.key === 'name')?.value).toBe('夜夜');
  });

  it('节流：间隔内第二次调用不再调 LLM', async () => {
    const store = new InMemoryProfileStore();
    const generate = vi.fn(async () => ({
      text: '{"facts":[{"key":"a","value":"1","category":"fact","event":"ADD"}]}',
    }));
    const llm: LLMProvider = {
      name: 'fake',
      model: 'test',
      configured: true,
      async *chat() {
        yield { delta: '' };
      },
      async generate() {
        return generate();
      },
    };
    const ingestor = new ProfileIngestor({ llm, store, minIntervalMs: 60_000 });
    await ingestor.ingest('第一条');
    const second = await ingestor.ingest('第二条');
    expect(second).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('LLM 失败静默不抛错', async () => {
    const store = new InMemoryProfileStore();
    const llm: LLMProvider = {
      name: 'fake',
      model: 'test',
      configured: true,
      async *chat() {
        yield { delta: '' };
      },
      async generate(): Promise<GenerateResult> {
        throw new Error('boom');
      },
    };
    const ingestor = new ProfileIngestor({ llm, store, minIntervalMs: 0 });
    await expect(ingestor.ingest('测试')).resolves.toBeUndefined();
  });

  it('抽取 prompt 携带现有画像与用户消息', () => {
    const messages = buildExtractionPrompt(
      [{ key: 'name', value: '旧名', category: 'fact', updatedAt: '' }],
      '我叫夜夜',
    );
    const joined = messages.map((m) => m.content).join('\n');
    expect(joined).toContain('[fact] name：旧名');
    expect(joined).toContain('我叫夜夜');
    expect(joined).toContain('ADD|UPDATE|DELETE|NONE');
  });
});
