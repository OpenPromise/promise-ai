import { describe, expect, it } from 'vitest';
import { InMemoryReminderStore } from './reminders.js';

describe('InMemoryReminderStore', () => {
  it('add 创建未完成提醒，list 按到期时间排序且默认不含已完成', async () => {
    const store = new InMemoryReminderStore();
    await store.add({ text: '晚点提醒', dueAt: '2099-01-02T00:00:00Z' });
    await store.add({ text: '先提醒', dueAt: '2099-01-01T00:00:00Z' });
    await store.add({ text: '无时间备忘' });

    const list = await store.list();
    expect(list.map((r) => r.text)).toEqual(['先提醒', '晚点提醒', '无时间备忘']);
    expect(list.every((r) => !r.done)).toBe(true);
  });

  it('markDone 标记完成后不再出现在默认列表，includeDone 可查', async () => {
    const store = new InMemoryReminderStore();
    const reminder = await store.add({ text: '喝水' });
    const marked = await store.markDone(reminder.id);
    expect(marked?.done).toBe(true);
    expect(await store.list()).toHaveLength(0);
    expect(await store.list(true)).toHaveLength(1);
    expect(await store.markDone('does-not-exist')).toBeUndefined();
  });
});
