import { describe, expect, it } from 'vitest';
import { InMemoryUsageStore, estimateDeepSeekCostCny, resolveUsageCostCny } from './usage.js';

describe('estimateDeepSeekCostCny', () => {
  it('estimates deepseek-chat rates', () => {
    // 1M in + 1M out → 1 + 2 = 3 元
    expect(estimateDeepSeekCostCny('deepseek-chat', 1_000_000, 1_000_000)).toBe(3);
  });

  it('estimates reasoner rates', () => {
    expect(estimateDeepSeekCostCny('deepseek-reasoner', 1_000_000, 1_000_000)).toBe(20);
  });

  it('returns undefined for unknown models', () => {
    expect(estimateDeepSeekCostCny('gpt-4o', 100, 100)).toBeUndefined();
  });
});

describe('resolveUsageCostCny', () => {
  it('uses explicit cost when provided', () => {
    expect(
      resolveUsageCostCny({
        provider: 'deepseek',
        model: 'deepseek-chat',
        inputTokens: 10,
        outputTokens: 10,
        costCny: 0.42,
      }),
    ).toBe(0.42);
  });

  it('estimates when provider is deepseek', () => {
    const cost = resolveUsageCostCny({
      provider: 'deepseek',
      model: 'deepseek-chat',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).toBe(1);
  });
});

describe('InMemoryUsageStore', () => {
  it('records calls and summarizes by colleague and model for 24h', async () => {
    const store = new InMemoryUsageStore();
    const now = new Date('2026-09-11T12:00:00Z');
    await store.record({
      sessionId: '11111111-1111-1111-1111-111111111111',
      colleague: 'xiaoye',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 100,
      outputTokens: 50,
      createdAt: '2026-09-11T11:00:00Z',
    });
    await store.record({
      colleague: 'xiaohei',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 200,
      outputTokens: 80,
      createdAt: '2026-09-11T10:00:00Z',
    });
    await store.record({
      colleague: 'xiaoye',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 40,
      outputTokens: 10,
      createdAt: '2026-09-09T10:00:00Z', // outside 24h
    });

    const summary = await store.summary({ period: '24h', now });
    expect(summary.calls).toBe(2);
    expect(summary.inputTokens).toBe(300);
    expect(summary.outputTokens).toBe(130);
    expect(summary.totalTokens).toBe(430);
    expect(summary.byColleague.map((row) => row.colleague)).toEqual(['xiaohei', 'xiaoye']);
    expect(summary.byColleague[0]?.totalTokens).toBe(280);
    expect(summary.byModel).toHaveLength(1);
    expect(summary.byModel[0]?.model).toBe('deepseek-chat');
    expect(summary.costCny).toBeGreaterThan(0);
  });

  it('today period uses local midnight bound', async () => {
    const store = new InMemoryUsageStore();
    const now = new Date('2026-09-11T15:30:00');
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    await store.record({
      colleague: 'xiaoye',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 10,
      outputTokens: 5,
      createdAt: new Date(midnight.getTime() + 60_000).toISOString(),
    });
    await store.record({
      colleague: 'xiaoye',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 99,
      outputTokens: 99,
      createdAt: new Date(midnight.getTime() - 60_000).toISOString(),
    });
    const summary = await store.summary({ period: 'today', now });
    expect(summary.calls).toBe(1);
    expect(summary.inputTokens).toBe(10);
  });
});
