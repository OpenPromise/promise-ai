import { describe, expect, it } from 'vitest';
import {
  applyAvatarDelta,
  applyAssetOverrides,
  computeEvolutionScore,
  defaultAvatarGenome,
  generateAssetPreview,
  InMemoryAvatarStore,
  mapPreferenceToAvatar,
  MAX_EVOLUTION_DELTA,
  validateAssetParams,
} from './avatar.js';

describe('applyAvatarDelta（渐变原则）', () => {
  it('参数变化被钳制在 ±0.08 且不超过 0~1', () => {
    const genome = defaultAvatarGenome();
    const applied = applyAvatarDelta(genome, 'hairColor', 1.0)!;
    expect(applied.event.newValue - applied.event.oldValue).toBeLessThanOrEqual(
      MAX_EVOLUTION_DELTA + 1e-9,
    );
    expect(applied.genome.appearance.hairColor).toBeLessThanOrEqual(1);

    const low = defaultAvatarGenome();
    low.appearance.hairColor = 0.02;
    const down = applyAvatarDelta(low, 'hairColor', -1.0)!;
    expect(down.event.newValue).toBe(0);
  });

  it('未知参数返回 null；可作用于 personality', () => {
    expect(applyAvatarDelta(defaultAvatarGenome(), 'not_a_param', 0.05)).toBeNull();
    const applied = applyAvatarDelta(defaultAvatarGenome(), 'confidence', 0.05)!;
    expect(applied.genome.personality.confidence).toBeCloseTo(0.55, 5);
  });

  it('进化代次递增并记录事件', () => {
    const genome = defaultAvatarGenome();
    const applied = applyAvatarDelta(genome, 'minimalStyle', 0.05, '长期偏好极简');
    expect(applied?.genome.evolution.generation).toBe(1);
    expect(applied?.event.reason).toBe('长期偏好极简');
    expect(applied?.event.parameter).toBe('minimalStyle');
  });
});

describe('InMemoryAvatarStore', () => {
  it('保存/读取 genome，交互计数递增', async () => {
    const store = new InMemoryAvatarStore();
    const genome = await store.getGenome();
    expect(genome.identity.baseModel).toBe('base-avatar.vrm');
    await store.recordInteraction();
    await store.recordInteraction();
    const updated = await store.getGenome();
    expect(updated.evolution.totalInteractions).toBe(2);
  });

  it('偏好证据积累置信度', async () => {
    const store = new InMemoryAvatarStore();
    for (let i = 0; i < 3; i++) {
      await store.addPreferenceEvidence({
        parameter: 'hairColor',
        direction: 1,
        source: 'user',
        confidence: 0.3,
        consistency: 1,
      });
    }
    const prefs = await store.listPreferences();
    expect(prefs[0]?.evidenceCount).toBe(3);
    expect(prefs[0]?.confidence).toBeGreaterThan(0.3);
  });

  it('进化事件按新→旧返回', async () => {
    const store = new InMemoryAvatarStore();
    const genome = await store.getGenome();
    const first = applyAvatarDelta(genome, 'hairColor', 0.05)!;
    await store.saveGenome(first.genome);
    await store.addEvolutionEvent(first.event);
    const second = applyAvatarDelta(first.genome, 'cuteStyle', 0.05)!;
    await store.saveGenome(second.genome);
    await store.addEvolutionEvent(second.event);
    const events = await store.listEvolutionEvents();
    expect(events[0]?.parameter).toBe('cuteStyle');
    expect(events[1]?.parameter).toBe('hairColor');
  });

  it('资产参数校验：拒绝未知键/越界值/空参数', () => {
    expect(validateAssetParams({ hairColor: 0.8 }).ok).toBe(true);
    expect(validateAssetParams({ not_a_param: 0.5 }).ok).toBe(false);
    expect(validateAssetParams({ hairColor: 1.5 }).ok).toBe(false);
    expect(validateAssetParams({ hairColor: 'blue' }).ok).toBe(false);
    expect(validateAssetParams({}).ok).toBe(false);
    expect(validateAssetParams(null).ok).toBe(false);
  });

  it('资产预览生成 SVG data URL', () => {
    const preview = generateAssetPreview('hair', { hairColor: 0.85, hairLength: 0.7 });
    expect(preview.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(preview).toContain('%3Csvg');
  });

  it('有效外观 = 基因 + 资产覆盖（顺序后胜出）', async () => {
    const store = new InMemoryAvatarStore();
    const hair = await store.createAsset({
      type: 'hair',
      name: '海盐蓝渐变发',
      params: { hairColor: 0.85, hairLength: 0.7 },
    });
    const style = await store.createAsset({
      type: 'style',
      name: '赛博极简',
      params: { cyberStyle: 0.8, minimalStyle: 0.7 },
    });
    await store.setActiveAsset('hair', hair.id);
    await store.setActiveAsset('style', style.id);
    const snapshot = await store.getSnapshot();
    const effective = applyAssetOverrides(snapshot.genome, snapshot.activeAssets);
    expect(effective.appearance.hairColor).toBeCloseTo(0.85, 5);
    expect(effective.appearance.cyberStyle).toBeCloseTo(0.8, 5);
    expect(effective.appearance.eyeColor).toBe(0.5); // 未覆盖保持基因值
  });

  it('资产 create/apply/clear/archive 全流程', async () => {
    const store = new InMemoryAvatarStore();
    const asset = await store.createAsset({
      type: 'clothing',
      name: '雾紫风衣',
      params: { clothingColor: 0.2 },
    });
    expect(asset.status).toBe('active');
    expect(asset.preview).toContain('data:image/svg+xml');

    await store.setActiveAsset('clothing', asset.id);
    await store.recordAssetUse(asset.id);
    let active = await store.getActiveAssets();
    expect(active.map((a) => a.id)).toEqual([asset.id]);

    await store.setActiveAsset('clothing', null);
    active = await store.getActiveAssets();
    expect(active).toHaveLength(0);

    await store.setAssetStatus(asset.id, 'archived');
    expect(await store.getAsset(asset.id)).toMatchObject({ status: 'archived' });
    await expect(store.setActiveAsset('clothing', asset.id)).rejects.toThrow('已归档');
  });
});

describe('computeEvolutionScore（用户计划 §7 公式）', () => {
  const base = {
    confidence: 0.9,
    evidenceCount: 5,
    consistency: 1,
    source: 'user' as const,
    firstSeenAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
  };
  it('证据充足且长期稳定 → 高分', () => {
    expect(computeEvolutionScore(base)).toBeGreaterThanOrEqual(0.5);
  });
  it('单次证据 → 低分（不足触发）', () => {
    const weak = {
      ...base,
      confidence: 0.3,
      evidenceCount: 1,
      firstSeenAt: new Date().toISOString(),
    };
    expect(computeEvolutionScore(weak)).toBeLessThan(0.5);
  });
  it('时间因子：新证据分数更低', () => {
    const fresh = { ...base, firstSeenAt: new Date().toISOString() };
    expect(computeEvolutionScore(fresh)).toBeLessThan(computeEvolutionScore(base));
  });
});

describe('mapPreferenceToAvatar（偏好文本 → 参数方向）', () => {
  it('识别蓝色/极简/科技/可爱等关键词', () => {
    expect(mapPreferenceToAvatar('我喜欢蓝色')).toEqual([
      { parameter: 'hairColor', direction: 1 },
    ]);
    expect(mapPreferenceToAvatar('我喜欢极简风格')).toEqual([
      { parameter: 'minimalStyle', direction: 1 },
    ]);
    expect(mapPreferenceToAvatar('有点赛博朋克')).toEqual([
      { parameter: 'cyberStyle', direction: 1 },
    ]);
    expect(mapPreferenceToAvatar('短发好看')).toEqual([
      { parameter: 'hairLength', direction: -1 },
    ]);
  });
  it('无关文本无命中', () => {
    expect(mapPreferenceToAvatar('今天天气不错')).toEqual([]);
  });
});
