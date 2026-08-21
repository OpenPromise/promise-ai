import type { Tool } from './index.js';
import type { CreateReminderInput, ReminderStore } from '@personal-ai/memory';
import { InMemoryReminderStore } from '@personal-ai/memory';

interface ListRemindersInput {
  includeDone?: boolean;
}

export function createReminderTools(store: ReminderStore = new InMemoryReminderStore()): Tool[] {
  return [
    {
      name: 'reminder.create',
      description: '创建一条提醒。可指定提醒内容与到期时间（ISO 8601）。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '提醒内容' },
          dueAt: {
            type: 'string',
            description: '到期时间（ISO 8601），如 2026-08-20T09:00:00+08:00',
          },
        },
        required: ['text'],
      },
      permissionLevel: 1,
      async execute(input: unknown) {
        const { text, dueAt } = (input ?? {}) as CreateReminderInput;
        if (!text?.trim()) {
          return { ok: false, error: '缺少 text 参数' };
        }
        if (dueAt !== undefined && Number.isNaN(Date.parse(dueAt))) {
          return { ok: false, error: 'dueAt 不是有效的 ISO 8601 时间' };
        }
        const reminder = await store.add({ text: text.trim(), ...(dueAt ? { dueAt } : {}) });
        return { ok: true, data: { reminder } };
      },
    },
    {
      name: 'reminder.list',
      description: '列出提醒（默认只返回未完成的，按到期时间排序）。',
      inputSchema: {
        type: 'object',
        properties: {
          includeDone: { type: 'boolean', description: '是否包含已完成的提醒' },
        },
        required: [],
      },
      permissionLevel: 0,
      async execute(input: unknown) {
        const { includeDone = false } = (input ?? {}) as ListRemindersInput;
        return { ok: true, data: { reminders: await store.list(includeDone) } };
      },
    },
  ];
}
