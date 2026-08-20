import type {
  TimelineEventType,
  TimelineStore,
} from '@personal-ai/memory';
import type { Tool, ToolResult } from '@personal-ai/tools';

/**
 * 事件时间线工具：
 * - timeline.list（L0）：按时间/类型查看最近发生的事件
 * - timeline.add（L1）：手动记录一条重要事件（生活节点/里程碑等）
 */

const TYPES: TimelineEventType[] = [
  'chat',
  'task',
  'profile',
  'cloud',
  'system',
  'note',
];

export interface TimelineToolOptions {
  store: TimelineStore;
}

export function createTimelineTools(options: TimelineToolOptions): Tool[] {
  const { store } = options;
  return [
    {
      name: 'timeline.list',
      description:
        '查看事件时间线（只读 L0）：按时间倒序返回最近发生的事件' +
        '（对话/任务/画像/云操作/生活事件）。可按类型过滤、limit 限制条数。',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: TYPES,
            description: '事件类型过滤（chat/task/profile/cloud/system/note）',
          },
          limit: {
            type: 'number',
            minimum: 1,
            maximum: 100,
            description: '返回条数，默认 20',
          },
        },
        required: [],
      },
      permissionLevel: 0,
      async execute(input: unknown): Promise<ToolResult> {
        const { type, limit } = (input ?? {}) as {
          type?: TimelineEventType;
          limit?: number;
        };
        const events = await store.listEvents({
          ...(type && TYPES.includes(type) ? { type } : {}),
          limit: Math.min(Math.max(1, Math.floor(limit ?? 20)), 100),
        });
        return {
          ok: true,
          data: {
            count: events.length,
            events,
            note: events.length === 0 ? '时间线还没有事件' : undefined,
          },
        };
      },
    },
    {
      name: 'timeline.add',
      description:
        '记录一条重要事件到时间线（L1）：用户透露的生活节点、里程碑、计划等，' +
        '供未来跨会话回忆与主动提醒。summary 一句话说清"发生了什么"。',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', minLength: 1, maxLength: 300, description: '事件摘要' },
          type: {
            type: 'string',
            enum: TYPES,
            description: '事件类型，默认 note',
          },
        },
        required: ['summary'],
      },
      permissionLevel: 1,
      async execute(input: unknown): Promise<ToolResult> {
        const { summary, type } = (input ?? {}) as {
          summary?: string;
          type?: TimelineEventType;
        };
        const trimmed = summary?.trim();
        if (!trimmed) return { ok: false, error: '缺少 summary 参数' };
        const event = await store.addEvent({
          type: type && TYPES.includes(type) ? type : 'note',
          summary: trimmed.slice(0, 300),
        });
        return {
          ok: true,
          data: { event, note: `已记录时间线事件：${trimmed.slice(0, 80)}` },
        };
      },
    },
  ];
}
