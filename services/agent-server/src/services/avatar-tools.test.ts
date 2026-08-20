import { describe, expect, it } from 'vitest';
import { InMemoryAvatarStore } from '@personal-ai/memory';
import { createAvatarTools } from './avatar-tools.js';

function makeTools() {
  const store = new InMemoryAvatarStore();
  const tools = createAvatarTools({ store });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { store, byName };
}

describe('avatar.* 工具', () => {
  it('权限：state/history/preferences=L0，propose_evolution=L1', () => {
    const { byName } = makeTools();
    expect(byName.get('avatar.state')?.permissionLevel).toBe(0);
    expect(byName.get('avatar.history')?.permissionLevel).toBe(0);
    expect(byName.get('avatar.preferences')?.permissionLevel).toBe(0);
    expect(byName.get('avatar.propose_evolution')?.permissionLevel).toBe(1);
  });

  it('state 返回默认基因组', async () => {
    const { byName } = makeTools();
    const result = await byName.get('avatar.state')!.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect((result.data as { identity: { baseModel: string } }).identity.baseModel).toBe(
      'base-avatar.vrm',
    );
  });

  it('propose_evolution 证据不足时拒绝并给出得分', async () => {
    const { store, byName } = makeTools();
    // 单条 user 证据，远不足以触发
    await store.addPreferenceEvidence({
      parameter: 'hairColor',
      direction: 1,
      source: 'user',
      confidence: 0.3,
      consistency: 1,
    });
    const result = await byName.get('avatar.propose_evolution')!.execute(
      { parameter: 'hairColor', direction: 1, source: 'user', reason: '喜欢蓝色' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('EvolutionScore');
    const genome = await store.getGenome();
    expect(genome.appearance.hairColor).toBe(0.5);
  });

  it('propose_evolution 证据充足时应用并写成长史', async () => {
    const store = new InMemoryAvatarStore();
    const tools = createAvatarTools({ store, evolveThreshold: 0 });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    await store.addPreferenceEvidence({
      parameter: 'minimalStyle',
      direction: 1,
      source: 'ai',
      confidence: 0.92,
      consistency: 1,
    });
    const result = await byName.get('avatar.propose_evolution')!.execute(
      { parameter: 'minimalStyle', direction: 1, source: 'ai', reason: 'AI 审美偏向极简' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    const genome = await store.getGenome();
    expect(genome.evolution.generation).toBeGreaterThan(0);
    expect((result.data as { applied: boolean }).applied).toBe(true);
  });
});
