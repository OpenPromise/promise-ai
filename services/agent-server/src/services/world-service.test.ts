import { describe, expect, it } from 'vitest';
import { InMemoryTimelineStore, InMemoryWorldStore } from '@personal-ai/memory';
import {
  scheduledActivityFor,
  WORLD_SCHEDULE,
  WorldService,
} from './world-service.js';
import { WorldEventBus } from './world-events.js';

function makeService(now: Date) {
  const store = new InMemoryWorldStore();
  const timeline = new InMemoryTimelineStore();
  const bus = new WorldEventBus();
  const events: unknown[] = [];
  bus.subscribe((state) => events.push(state));
  const service = new WorldService({ store, timeline, bus });
  return { store, timeline, bus, events, service };
}

describe('WORLD_SCHEDULE（活动表）', () => {
  it('24 小时全覆盖且顺序递增', () => {
    let cursor = 0;
    for (const entry of WORLD_SCHEDULE) {
      expect(entry.startHour).toBe(cursor);
      expect(entry.endHour).toBeGreaterThan(entry.startHour);
      cursor = entry.endHour;
    }
    expect(cursor).toBe(24);
  });

  it('scheduledActivityFor 按时段返回活动', () => {
    expect(scheduledActivityFor(3)?.kind).toBe('sleeping');
    expect(scheduledActivityFor(10)?.kind).toBe('working');
    expect(scheduledActivityFor(15)?.kind).toBe('reading');
    expect(scheduledActivityFor(21)?.kind).toBe('chatting');
    expect(scheduledActivityFor(99)).toBeNull();
  });
});

describe('WorldService（活动循环）', () => {
  it('首次 tick 按当前时段设置活动，写 timeline 并广播', async () => {
    const now = new Date('2026-08-20T10:30:00+08:00');
    const { store, timeline, events, service } = makeService(now);
    const state = await service.tick(now);
    expect(state.activity?.kind).toBe('working');
    expect(state.activity?.location).toBe('书房');
    expect(state.totalActions).toBe(1);
    const worldEvents = await timeline.listEvents({ type: 'world' });
    expect(worldEvents).toHaveLength(1);
    expect(worldEvents[0]?.summary).toContain('工作台');
    expect(events).toHaveLength(1);
  });

  it('同一时段重复 tick 不重复切换', async () => {
    const now = new Date('2026-08-20T10:30:00+08:00');
    const { store, timeline, service } = makeService(now);
    await service.tick(now);
    const after = await service.tick(new Date('2026-08-20T10:45:00+08:00'));
    expect(after.totalActions).toBe(1);
    expect((await timeline.listEvents({ type: 'world' })).length).toBe(1);
  });

  it('跨时段 tick 自动切换到新活动', async () => {
    const now = new Date('2026-08-20T10:30:00+08:00');
    const { store, timeline, service } = makeService(now);
    await service.tick(now);
    const after = await service.tick(new Date('2026-08-20T14:00:00+08:00'));
    expect(after.activity?.kind).toBe('reading');
    expect(after.totalActions).toBe(2);
    const events = await timeline.listEvents({ type: 'world' });
    expect(events.map((e) => e.summary)).toEqual([
      expect.stringContaining('书架'),
      expect.stringContaining('工作台'),
    ]);
  });

  it('act 手动活动保留 durationMin，到期后回到时段默认', async () => {
    const now = new Date('2026-08-20T15:00:00+08:00');
    const { store, timeline, service } = makeService(now);
    await service.tick(now);
    const acted = await service.act({ label: '去阳台吹风', durationMin: 60 }, now);
    expect(acted.activity?.label).toBe('去阳台吹风');
    expect(acted.activity?.kind).toBe('custom');
    expect(acted.activity?.location).toBe('阳台');

    // 30 分钟后（手动活动未到期）保持
    const kept = await service.tick(new Date('2026-08-20T15:30:00+08:00'));
    expect(kept.activity?.label).toBe('去阳台吹风');
    // 90 分钟后（手动活动已到期）回到时段默认（reading）
    const back = await service.tick(new Date('2026-08-20T16:30:00+08:00'));
    expect(back.activity?.kind).toBe('reading');
    expect((await timeline.listEvents({ type: 'world' })).length).toBe(3);
  });

  it('act 非法 kind 回退 custom，label 过长被截断', async () => {
    const { service } = makeService(new Date('2026-08-20T10:00:00+08:00'));
    const state = await service.act({
      kind: 'not-a-kind' as never,
      label: 'x'.repeat(100),
      durationMin: 500,
    });
    expect(state.activity?.kind).toBe('custom');
    expect(state.activity?.label).toHaveLength(60);
    expect(state.activity?.until).toBeDefined();
  });
});
