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
  it('权限：state/history/preferences/assets=L0，其余=L1', () => {
    const { byName } = makeTools();
    expect(byName.get('avatar.state')?.permissionLevel).toBe(0);
    expect(byName.get('avatar.history')?.permissionLevel).toBe(0);
    expect(byName.get('avatar.preferences')?.permissionLevel).toBe(0);
    expect(byName.get('avatar.assets')?.permissionLevel).toBe(0);
    expect(byName.get('avatar.propose_evolution')?.permissionLevel).toBe(1);
    expect(byName.get('avatar.auto_evolve')?.permissionLevel).toBe(1);
    expect(byName.get('avatar.design_asset')?.permissionLevel).toBe(1);
    expect(byName.get('avatar.apply_asset')?.permissionLevel).toBe(1);
    expect(byName.get('avatar.clear_asset')?.permissionLevel).toBe(1);
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

  it('auto_evolve 对达标偏好自动应用并写成长史', async () => {
    const store = new InMemoryAvatarStore();
    const tools = createAvatarTools({ store, evolveThreshold: 0 });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    await store.addPreferenceEvidence({
      parameter: 'cuteStyle',
      direction: 1,
      source: 'user',
      confidence: 0.9,
      consistency: 1,
    });
    const result = await byName.get('avatar.auto_evolve')!.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    const data = result.data as { applied: number; genome: { evolution: { generation: number } } };
    expect(data.applied).toBe(1);
    expect(data.genome.evolution.generation).toBe(1);
    const genome = await store.getGenome();
    expect(genome.appearance.cuteStyle).toBeGreaterThan(0.5);
  });

  it('auto_evolve 证据不足时不应用', async () => {
    const store = new InMemoryAvatarStore();
    const tools = createAvatarTools({ store });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    await store.addPreferenceEvidence({
      parameter: 'minimalStyle',
      direction: 1,
      source: 'user',
      confidence: 0.3,
      consistency: 1,
    });
    const result = await byName.get('avatar.auto_evolve')!.execute({}, { sessionId: 's1' });
    const data = result.data as { applied: number };
    expect(data.applied).toBe(0);
  });

  it('auto_evolve 同参数两方向都达标时冲突跳过', async () => {
    const store = new InMemoryAvatarStore();
    const tools = createAvatarTools({ store, evolveThreshold: 0 });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    await store.addPreferenceEvidence({
      parameter: 'hairColor',
      direction: 1,
      source: 'user',
      confidence: 0.9,
      consistency: 1,
    });
    await store.addPreferenceEvidence({
      parameter: 'hairColor',
      direction: -1,
      source: 'user',
      confidence: 0.9,
      consistency: 1,
    });
    const result = await byName.get('avatar.auto_evolve')!.execute({}, { sessionId: 's1' });
    const data = result.data as {
      applied: number;
      skipped: Array<{ parameter: string }>;
    };
    expect(data.applied).toBe(0);
    expect(data.skipped.some((s) => s.parameter === 'hairColor')).toBe(true);
  });

  it('design_asset 校验参数并入库，非法参数拒绝', async () => {
    const { store, byName } = makeTools();
    const bad = await byName.get('avatar.design_asset')!.execute(
      {
        name: '非法资产',
        type: 'hair',
        params: { hairColor: 2.5 },
      },
      { sessionId: 's1' },
    );
    expect(bad.ok).toBe(false);
    expect(await store.listAssets()).toHaveLength(0);

    const result = await byName.get('avatar.design_asset')!.execute(
      {
        name: '海盐蓝渐变发',
        type: 'hair',
        description: '像海水一样清凉的蓝',
        params: { hairColor: 0.85, hairLength: 0.7 },
      },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    const data = result.data as { created: boolean; asset: { name: string; preview: string } };
    expect(data.created).toBe(true);
    expect(data.asset.name).toBe('海盐蓝渐变发');
    expect(data.asset.preview).toContain('data:image/svg+xml');
    expect(await store.listAssets()).toHaveLength(1);
  });

  it('apply_asset 穿上并记录使用，clear_asset 脱下', async () => {
    const { store, byName } = makeTools();
    const designed = await byName.get('avatar.design_asset')!.execute(
      {
        name: '雾紫风衣',
        type: 'clothing',
        params: { clothingColor: 0.2 },
      },
      { sessionId: 's1' },
    );
    const assetId = (designed.data as { asset: { id: string } }).asset.id;

    const applied = await byName.get('avatar.apply_asset')!.execute(
      { assetId },
      { sessionId: 's1' },
    );
    expect(applied.ok).toBe(true);
    expect((applied.data as { applied: boolean }).applied).toBe(true);
    expect((await store.getActiveAssets()).map((a) => a.id)).toEqual([assetId]);
    expect((await store.getAsset(assetId))?.usageCount).toBe(1);

    const cleared = await byName.get('avatar.clear_asset')!.execute(
      { type: 'clothing' },
      { sessionId: 's1' },
    );
    expect(cleared.ok).toBe(true);
    expect(await store.getActiveAssets()).toHaveLength(0);
  });

  it('apply_asset 未知 id / 归档资产被拒绝', async () => {
    const { store, byName } = makeTools();
    const missing = await byName.get('avatar.apply_asset')!.execute(
      { assetId: 'not-exist' },
      { sessionId: 's1' },
    );
    expect(missing.ok).toBe(false);

    const designed = await byName.get('avatar.design_asset')!.execute(
      { name: '旧款', type: 'accessory', params: { accessoryLevel: 0.8 } },
      { sessionId: 's1' },
    );
    const assetId = (designed.data as { asset: { id: string } }).asset.id;
    await store.setAssetStatus(assetId, 'archived');
    const archived = await byName.get('avatar.apply_asset')!.execute(
      { assetId },
      { sessionId: 's1' },
    );
    expect(archived.ok).toBe(false);
    expect(archived.error).toContain('已归档');
  });
});
