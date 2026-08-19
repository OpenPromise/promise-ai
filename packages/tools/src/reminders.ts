import { randomUUID } from 'node:crypto';
import type { Tool } from './index.js';

export interface Reminder {
  id: string;
  text: string;
  dueAt?: string;
  createdAt: string;
  done: boolean;
}

interface CreateReminderInput {
  text: string;
  dueAt?: string;
}

interface ListRemindersInput {
  includeDone?: boolean;
}

export class InMemoryReminderStore {
  readonly #items: Reminder[] = [];

  add(input: CreateReminderInput): Reminder {
    const reminder: Reminder = {
      id: randomUUID(),
      text: input.text,
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      createdAt: new Date().toISOString(),
      done: false,
    };
    this.#items.push(reminder);
    return reminder;
  }

  list(includeDone = false): Reminder[] {
    return this.#items
      .filter((item) => includeDone || !item.done)
      .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));
  }

  /** 标记提醒已完成；返回被标记的提醒，不存在时返回 undefined。 */
  markDone(id: string): Reminder | undefined {
    const item = this.#items.find((r) => r.id === id);
    if (!item) return undefined;
    item.done = true;
    return { ...item };
  }
}

export function createReminderTools(store = new InMemoryReminderStore()): Tool[] {
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
        const reminder = store.add({ text: text.trim(), ...(dueAt ? { dueAt } : {}) });
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
        return { ok: true, data: { reminders: store.list(includeDone) } };
      },
    },
  ];
}
