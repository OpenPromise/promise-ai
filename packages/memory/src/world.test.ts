import { describe, expect, it } from 'vitest';
import { InMemoryWorldStore } from './world.js';

describe('InMemoryWorldStore', () => {
  it('默认世界状态：客厅、无活动、0 行动', async () => {
    const store = new InMemoryWorldStore();
    const state = await store.getWorld();
    expect(state.location).toBe('客厅');
    expect(state.activity).toBeNull();
    expect(state.totalActions).toBe(0);
    expect(state.daysLived).toBe(0);
  });

  it('保存/读取世界状态', async () => {
    const store = new InMemoryWorldStore();
    const state = await store.getWorld();
    state.activity = {
      kind: 'reading',
      label: '在书架旁看书',
      emoji: '📖',
      location: '书房',
      startedAt: new Date().toISOString(),
      until: new Date().toISOString(),
    };
    await store.saveWorld(state);
    const loaded = await store.getWorld();
    expect(loaded.activity?.kind).toBe('reading');
    expect(loaded.activity?.location).toBe('书房');
  });
});
