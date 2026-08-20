import { describe, expect, it } from 'vitest';
import { InMemoryTimelineStore } from './timeline.js';

describe('InMemoryTimelineStore 事件时间线', () => {
  it('addEvent 记录并 listEvents 新→旧返回', async () => {
    const store = new InMemoryTimelineStore();
    await store.addEvent({ type: 'chat', summary: '第一次对话', sessionId: 's1' });
    await store.addEvent({ type: 'cloud', summary: '开放端口 8080', metadata: { port: 8080 } });
    const events = await store.listEvents();
    expect(events).toHaveLength(2);
    expect(events[0]?.summary).toBe('开放端口 8080');
    expect(events[1]?.type).toBe('chat');
    expect(events[1]?.sessionId).toBe('s1');
  });

  it('按类型过滤与 limit', async () => {
    const store = new InMemoryTimelineStore();
    await store.addEvent({ type: 'chat', summary: 'a' });
    await store.addEvent({ type: 'task', summary: 'b' });
    await store.addEvent({ type: 'chat', summary: 'c' });
    const chats = await store.listEvents({ type: 'chat' });
    expect(chats.map((e) => e.summary)).toEqual(['c', 'a']);
    const limited = await store.listEvents({ limit: 1 });
    expect(limited).toHaveLength(1);
  });
});
