import { randomUUID } from 'node:crypto';
import type { Tool } from './index.js';

export interface CalendarEvent {
  id: string;
  title: string;
  startAt: string;
  endAt?: string;
  createdAt: string;
}

interface CreateEventInput {
  title: string;
  startAt: string;
  endAt?: string;
}

interface ListEventsInput {
  from?: string;
  to?: string;
}

export class InMemoryCalendarStore {
  readonly #events: CalendarEvent[] = [];

  add(input: CreateEventInput): CalendarEvent {
    const event: CalendarEvent = {
      id: randomUUID(),
      title: input.title,
      startAt: input.startAt,
      ...(input.endAt ? { endAt: input.endAt } : {}),
      createdAt: new Date().toISOString(),
    };
    this.#events.push(event);
    return event;
  }

  list(from?: string, to?: string): CalendarEvent[] {
    const fromTime = from ? Date.parse(from) : Number.NEGATIVE_INFINITY;
    const toTime = to ? Date.parse(to) : Number.POSITIVE_INFINITY;
    return this.#events
      .filter((event) => {
        const start = Date.parse(event.startAt);
        return start >= fromTime && start <= toTime;
      })
      .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  }
}

export function createCalendarTools(store = new InMemoryCalendarStore()): Tool[] {
  return [
    {
      name: 'calendar.create',
      description: '在日历中创建一条日程。需要标题与开始时间（ISO 8601），可选结束时间。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '日程标题' },
          startAt: { type: 'string', description: '开始时间（ISO 8601）' },
          endAt: { type: 'string', description: '结束时间（ISO 8601，可选）' },
        },
        required: ['title', 'startAt'],
      },
      permissionLevel: 1,
      async execute(input: unknown) {
        const { title, startAt, endAt } = (input ?? {}) as CreateEventInput;
        if (!title?.trim()) {
          return { ok: false, error: '缺少 title 参数' };
        }
        if (!startAt || Number.isNaN(Date.parse(startAt))) {
          return { ok: false, error: 'startAt 不是有效的 ISO 8601 时间' };
        }
        if (endAt !== undefined && Number.isNaN(Date.parse(endAt))) {
          return { ok: false, error: 'endAt 不是有效的 ISO 8601 时间' };
        }
        const event = store.add({ title: title.trim(), startAt, ...(endAt ? { endAt } : {}) });
        return { ok: true, data: { event } };
      },
    },
    {
      name: 'calendar.list',
      description: '列出日程。可按时间范围过滤，默认返回未来 7 天。',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '起始时间（ISO 8601，可选）' },
          to: { type: 'string', description: '结束时间（ISO 8601，可选）' },
        },
        required: [],
      },
      permissionLevel: 0,
      async execute(input: unknown) {
        const { from, to } = (input ?? {}) as ListEventsInput;
        if (from !== undefined && Number.isNaN(Date.parse(from))) {
          return { ok: false, error: 'from 不是有效的 ISO 8601 时间' };
        }
        if (to !== undefined && Number.isNaN(Date.parse(to))) {
          return { ok: false, error: 'to 不是有效的 ISO 8601 时间' };
        }
        return { ok: true, data: { events: store.list(from, to) } };
      },
    },
  ];
}
