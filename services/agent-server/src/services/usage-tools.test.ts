import { describe, expect, it } from 'vitest';
import { InMemoryUsageStore } from '@personal-ai/memory';
import { createUsageTools } from './usage-tools.js';

describe('createUsageTools', () => {
  it('usage.summary is L0 and returns empty-note when no rows', async () => {
    const store = new InMemoryUsageStore();
    const tools = createUsageTools({ store });
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.name).toBe('usage.summary');
    expect(tool.permissionLevel).toBe(0);

    const result = await tool.execute({ period: 'today' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    const data = result.data as { calls: number; note?: string; period: string };
    expect(data.period).toBe('today');
    expect(data.calls).toBe(0);
    expect(data.note).toContain('还没有用量');
  });

  it('usage.summary aggregates recent records and falls back on bad period', async () => {
    const store = new InMemoryUsageStore();
    await store.record({
      colleague: 'xiaoye',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 100,
      outputTokens: 20,
    });
    await store.record({
      colleague: 'xiaohei',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 50,
      outputTokens: 10,
    });
    const [tool] = createUsageTools({ store });
    const result = await tool!.execute({ period: 'week' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    const data = result.data as {
      period: string;
      calls: number;
      totalTokens: number;
      byColleague: Array<{ colleague: string }>;
      byModel: Array<{ model: string }>;
    };
    expect(data.period).toBe('24h');
    expect(data.calls).toBe(2);
    expect(data.totalTokens).toBe(180);
    expect(data.byColleague.map((row) => row.colleague).sort()).toEqual(['xiaohei', 'xiaoye']);
    expect(data.byModel[0]?.model).toBe('deepseek-chat');
  });
});
