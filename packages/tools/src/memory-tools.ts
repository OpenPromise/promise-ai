import type { MemoryKind, MemoryStore } from '@personal-ai/memory';
import type { Tool } from './index.js';

interface RememberInput {
  kind?: MemoryKind;
  content: string;
}

interface ListInput {
  kind?: MemoryKind;
}

interface ForgetInput {
  id: string;
}

interface EditInput {
  id: string;
  content: string;
}

/**
 * Memory tools expose the long-term memory store to the agent. Only valuable
 * long-term information should be stored (see the Memory 写入规则 in the plan);
 * the agent decides what qualifies.
 */
export function createMemoryTools(store: MemoryStore): Tool[] {
  return [
    {
      name: 'memory.remember',
      description:
        '保存一条长期记忆。kind 为 semantic（长期稳定事实，如用户偏好）或 episodic（重要事件），默认 semantic。只保存有长期价值的信息。',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['semantic', 'episodic'],
            description: '记忆类型：semantic 长期事实 / episodic 重要事件',
          },
          content: {
            type: 'string',
            description: '记忆内容（简洁、明确，如：用户喜欢喝美式咖啡）',
          },
        },
        required: ['content'],
      },
      permissionLevel: 1,
      async execute(input: unknown) {
        const { kind = 'semantic', content } = (input ?? {}) as RememberInput;
        if (!content?.trim()) {
          return { ok: false, error: '缺少 content 参数' };
        }
        const entry = await store.add({ kind, content: content.trim() });
        return { ok: true, data: { entry } };
      },
    },
    {
      name: 'memory.list',
      description: '列出长期记忆。可按 kind 过滤（semantic / episodic）。',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['semantic', 'episodic'],
            description: '记忆类型过滤',
          },
        },
        required: [],
      },
      permissionLevel: 0,
      async execute(input: unknown) {
        const { kind } = (input ?? {}) as ListInput;
        const entries = await store.list(kind);
        return { ok: true, data: { count: entries.length, memories: entries } };
      },
    },
    {
      name: 'memory.forget',
      description: '永久删除一条记忆。用户要求"忘记"时必须真实删除。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要删除的记忆 id（来自 memory.list）' },
        },
        required: ['id'],
      },
      permissionLevel: 1,
      async execute(input: unknown) {
        const { id } = (input ?? {}) as ForgetInput;
        if (!id?.trim()) {
          return { ok: false, error: '缺少 id 参数' };
        }
        const deleted = await store.forget(id);
        if (!deleted) {
          return { ok: false, error: '找不到该记忆' };
        }
        return { ok: true, data: { deleted: id } };
      },
    },
    {
      name: 'memory.edit',
      description: '修改一条记忆的内容。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要修改的记忆 id' },
          content: { type: 'string', description: '新的记忆内容' },
        },
        required: ['id', 'content'],
      },
      permissionLevel: 1,
      async execute(input: unknown) {
        const { id, content } = (input ?? {}) as EditInput;
        if (!id?.trim() || !content?.trim()) {
          return { ok: false, error: '缺少 id 或 content 参数' };
        }
        const updated = await store.edit(id, content.trim());
        if (!updated) {
          return { ok: false, error: '找不到该记忆' };
        }
        return { ok: true, data: { entry: updated } };
      },
    },
  ];
}
