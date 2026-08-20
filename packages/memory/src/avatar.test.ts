import { describe, expect, it } from 'vitest';
import {
  applyAvatarDelta,
  defaultAvatarGenome,
  InMemoryAvatarStore,
  MAX_EVOLUTION_DELTA,
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
});
