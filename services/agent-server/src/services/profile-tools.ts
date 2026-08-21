import type {
  ProfileCategory,
  ProfileStore,
} from '@personal-ai/memory';
import { resolveProfileUserId } from '@personal-ai/memory';
import type { LLMProvider } from '@personal-ai/llm';
import type { PermissionLevel, Tool, ToolResult } from '@personal-ai/tools';
import { compactProfile } from './profile-ingestor.js';

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
  /** 画像整理用 LLM（flash 即可）。 */
  llm: LLMProvider;
}

export function createProfileTools(options: ProfileToolOptions): Tool[] {
  const { store, llm } = options;

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
      async execute(input: unknown, context: { userId?: string }): Promise<ToolResult> {
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
        const profile = await store.upsertEntry(resolveProfileUserId(context.userId), {
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
      async execute(_input: unknown, context: { userId?: string }): Promise<ToolResult> {
        const profile = await store.getProfile(resolveProfileUserId(context.userId));
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
      async execute(input: unknown, context: { userId?: string }): Promise<ToolResult> {
        const { key } = (input ?? {}) as { key?: string };
        const trimmedKey = key?.trim();
        if (!trimmedKey) return { ok: false, error: '缺少 key 参数' };
        const profile = await store.removeEntry(resolveProfileUserId(context.userId), trimmedKey);
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
    {
      name: 'profile.compact',
      description:
        '整理用户画像（L1）：合并语义重复条目、删除陈旧/矛盾条目、精简冗长表述，' +
        '防止画像越积越多、注入上下文膨胀（Letta memory pressure）。' +
        '条目少于 20 条时直接跳过；整理后不超过 30 条。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      permissionLevel: 1 as PermissionLevel,
      async execute(_input: unknown, context: { userId?: string }): Promise<ToolResult> {
        const userId = resolveProfileUserId(context.userId);
        try {
          const result = await compactProfile(store, llm, userId);
          if (!result) {
            const profile = await store.getProfile(userId);
            return {
              ok: true,
              data: {
                compacted: false,
                count: profile?.entries.length ?? 0,
                note: '画像条数不多，无需整理',
              },
            };
          }
          return {
            ok: true,
            data: {
              compacted: true,
              before: result.before,
              after: result.after,
              removedKeys: result.removedKeys,
              note: `画像已整理：${result.before} → ${result.after} 条`,
            },
          };
        } catch (error) {
          return {
            ok: false,
            error: `画像整理失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
    {
      name: 'profile.history',
      description:
        '查看用户画像变更历史（只读 L0）：每次 ADD/UPDATE/DELETE 的时间、' +
        '旧值、新值。可按 key 过滤、limit 限制条数（新→旧）。',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', maxLength: 64, description: '只看某个 key 的历史' },
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
      async execute(input: unknown, context: { userId?: string }): Promise<ToolResult> {
        const { key, limit } = (input ?? {}) as { key?: string; limit?: number };
        const events = await store.listHistory(resolveProfileUserId(context.userId), {
          ...(key?.trim() ? { key: key.trim() } : {}),
          limit: Math.min(Math.max(1, Math.floor(limit ?? 20)), 100),
        });
        return {
          ok: true,
          data: {
            count: events.length,
            events,
            note: events.length === 0 ? '暂无变更历史' : undefined,
          },
        };
      },
    },
    {
      name: 'profile.rollback',
      description:
        '回滚用户画像的某个 key（L1）：默认撤销该 key 最近一次修改；' +
        '传 toEventId 则恢复到那次事件之后的状态（event id 用 profile.history 查）。' +
        '回滚会覆盖当前值，但回滚本身也会记录一条新事件，可再次回滚。',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 64, description: '要回滚的 key' },
          toEventId: {
            type: 'string',
            description: '恢复到该事件之后的状态；省略则撤销最近一次修改',
          },
        },
        required: ['key'],
      },
      permissionLevel: 1 as PermissionLevel,
      async execute(input: unknown, context: { userId?: string }): Promise<ToolResult> {
        const { key, toEventId } = (input ?? {}) as { key?: string; toEventId?: string };
        const trimmedKey = key?.trim();
        if (!trimmedKey) return { ok: false, error: '缺少 key 参数' };
        try {
          const profile = await store.rollbackEntry(resolveProfileUserId(context.userId), trimmedKey, {
            ...(toEventId?.trim() ? { toEventId: toEventId.trim() } : {}),
          });
          const current = profile.entries.find((entry) => entry.key === trimmedKey);
          return {
            ok: true,
            data: {
              key: trimmedKey,
              ...(toEventId?.trim()
                ? { toEventId: toEventId.trim() }
                : { undoLast: true }),
              currentValue: current?.value ?? null,
              note: current
                ? `已回滚 ${trimmedKey}，当前值：${current.value}`
                : `已回滚 ${trimmedKey}，当前无该条目`,
            },
          };
        } catch (error) {
          return {
            ok: false,
            error: `回滚失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
  ];

  return tools;
}
