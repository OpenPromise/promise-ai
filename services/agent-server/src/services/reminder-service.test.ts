import { describe, expect, it } from 'vitest';
import { InMemoryReminderStore } from '@personal-ai/tools';
import { ReminderService } from './reminder-service.js';

describe('ReminderService', () => {
  it('fires due reminders once, marks them done and never re-fires', () => {
    const store = new InMemoryReminderStore();
    store.add({ text: '该吃饭了', dueAt: new Date(Date.now() - 1000).toISOString() });
    store.add({ text: '该喝水了', dueAt: new Date(Date.now() + 60_000).toISOString() });

    const service = new ReminderService({ reminders: store, intervalMs: 1000 });
    const events: Array<{ text: string }> = [];
    service.onDue((event) => events.push(event));

    service.checkNow();
    expect(events.map((event) => event.text)).toEqual(['该吃饭了']);

    // 再次扫描不得重复触发
    service.checkNow();
    expect(events).toHaveLength(1);
    expect(store.list(false)).toHaveLength(1); // 只剩未到期的喝水提醒
    service.stop();
  });

  it('ignores reminders without a due time', () => {
    const store = new InMemoryReminderStore();
    store.add({ text: '纯备忘，无时间' });
    const service = new ReminderService({ reminders: store });
    const events: string[] = [];
    service.onDue((event) => events.push(event.text));

    service.checkNow();
    expect(events).toHaveLength(0);
    service.stop();
  });

  it('removes listeners on unsubscribe', () => {
    const store = new InMemoryReminderStore();
    store.add({ text: '测试', dueAt: new Date(Date.now() - 1000).toISOString() });
    const service = new ReminderService({ reminders: store });
    const events: string[] = [];
    const off = service.onDue((event) => events.push(event.text));
    off();

    service.checkNow();
    expect(events).toHaveLength(0);
    service.stop();
  });
});
