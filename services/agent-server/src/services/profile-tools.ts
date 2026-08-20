import type {
  ProfileCategory,
  ProfileStore,
} from '@personal-ai/memory';
import { resolveProfileUserId } from '@personal-ai/memory';
import type { PermissionLevel, Tool, ToolResult } from '@personal-ai/tools';

/**
 * 用户画像工具：结构化记住用户的事实 / 偏好 / 习惯 / 语气倾向，
 * 每次对话注入系统提示（见 conversation.ts 的 collectPersistentContext）。
 *
 * 权限说明（AGENTS.md）：profile.set / profile.forget 为 L1（常规写入，
 * 用户明确告知的信息记录，可覆盖/删除）；profile.list 为 L0（只读）。
 */

const CATEGORIES: ProfileCategory[] = ['fact', 'preference', 'habit', 'tone'];

export interface ProfileToolOptions {
  store: ProfileStore;
}

export function createProfileTools(options: ProfileToolOptions): Tool[] {
  const { store } = options;

  const tools: Tool[] = [
    {
      name: 'profile.set',
      description:
        '记录/更新一条用户画像信息（L1）：用户告诉你的事实、偏好、习惯、语气倾向，' +
        '跨会话永久记住并在每次对话注入。key 唯一（如 name / 称呼 / 作息 / 口味），' +
        '再次 set 同名 key 即覆盖。category：fact=事实、preference=偏好、' +
        'habit=习惯、tone=语气倾向，默认 fact。',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 64, description: '条目键名，如 name' },
          value: { type: 'string', minLength: 1, maxLength: 500, description: '条目内容' },
          category: {
            type: 'string',
            enum: CATEGORIES,
            description: '类别：fact/preference/habit/tone，默认 fact',
          },
        },
        required: ['key', 'value'],
      },
      permissionLevel: 1 as PermissionLevel,
      async execute(input: unknown): Promise<ToolResult> {
        const { key, value, category } = (input ?? {}) as {
          key?: string;
          value?: string;
          category?: ProfileCategory;
        };
        const trimmedKey = key?.trim();
        const trimmedValue = value?.trim();
        if (!trimmedKey || !trimmedValue) {
          return { ok: false, error: '缺少 key 或 value 参数' };
        }
        if (trimmedKey.length > 64 || trimmedValue.length > 500) {
          return { ok: false, error: 'key 最长 64 字符，value 最长 500 字符' };
        }
        const resolvedCategory = category && CATEGORIES.includes(category) ? category : 'fact';
        const profile = await store.upsertEntry(resolveProfileUserId(), {
          key: trimmedKey,
          value: trimmedValue,
          category: resolvedCategory,
        });
        return {
          ok: true,
          data: {
            key: trimmedKey,
            category: resolvedCategory,
            total: profile.entries.length,
            note: `已记录用户画像：${trimmedKey} = ${trimmedValue}`,
          },
        };
      },
    },
    {
      name: 'profile.list',
      description: '列出已记录的用户画像条目（只读 L0）：事实/偏好/习惯/语气倾向。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      permissionLevel: 0,
      async execute(): Promise<ToolResult> {
        const profile = await store.getProfile(resolveProfileUserId());
        const entries = profile?.entries ?? [];
        return {
          ok: true,
          data: {
            count: entries.length,
            entries,
            note: entries.length === 0 ? '还没有用户画像记录' : undefined,
          },
        };
      },
    },
    {
      name: 'profile.forget',
      description:
        '删除一条用户画像信息（L1，永久删除该条，可重新记录）：按 key 删除。',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 64, description: '要删除的条目键名' },
        },
        required: ['key'],
      },
      permissionLevel: 1 as PermissionLevel,
      async execute(input: unknown): Promise<ToolResult> {
        const { key } = (input ?? {}) as { key?: string };
        const trimmedKey = key?.trim();
        if (!trimmedKey) return { ok: false, error: '缺少 key 参数' };
        const profile = await store.removeEntry(resolveProfileUserId(), trimmedKey);
        return {
          ok: true,
          data: {
            key: trimmedKey,
            remaining: profile.entries.length,
            note: `已删除用户画像条目：${trimmedKey}`,
          },
        };
      },
    },
  ];

  return tools;
}
