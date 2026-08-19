import type { MemoryStore } from '@personal-ai/memory';
import type { Tool } from './index.js';

/** 长期目标记忆的内容前缀（供会话注入与 goal.list 过滤）。 */
export const GOAL_PREFIX = '[goal] ';

interface GoalSetInput {
  title: string;
  description?: string;
}

interface GoalDoneInput {
  id?: string;
  title?: string;
}

export function parseGoal(content: string): { title: string; description: string } | null {
  if (!content.startsWith(GOAL_PREFIX)) return null;
  const rest = content.slice(GOAL_PREFIX.length);
  const colon = rest.indexOf('：');
  if (colon === -1) return { title: rest.trim(), description: '' };
  return { title: rest.slice(0, colon).trim(), description: rest.slice(colon + 1).trim() };
}

/**
 * 持久目标工具（Prime Agent /goal 思路的轻量版）：目标以 `[goal]` 前缀写入
 * 长期记忆，跨会话存活，并随每次对话注入系统提示词。不引入新的存储抽象。
 */
export function createGoalTools(store: MemoryStore): Tool[] {
  const listGoals = async (): Promise<
    Array<{ id: string; title: string; description: string }>
  > => {
    const entries = (await store.list('semantic')).filter((entry) =>
      entry.content.startsWith(GOAL_PREFIX),
    );
    return entries
      .map((entry) => {
        const parsed = parseGoal(entry.content);
        if (!parsed) return null;
        return { id: entry.id, ...parsed };
      })
      .filter((goal): goal is { id: string; title: string; description: string } => goal !== null);
  };

  return [
    {
      name: 'goal.set',
      description:
        '设置/更新用户的长期目标（跨会话存活，每次对话都会注入给 AI）。' +
        '相同 title 会覆盖旧目标。长期目标与一次性任务不同，不要混用。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '目标标题（如：帮助用户减肥）' },
          description: {
            type: 'string',
            description: '目标细节/衡量标准（可选，如：三个月减 5 公斤）',
          },
        },
        required: ['title'],
      },
      permissionLevel: 1,
      async execute(input: unknown) {
        const { title, description } = (input ?? {}) as GoalSetInput;
        if (!title?.trim()) return { ok: false, error: '缺少 title 参数' };

        const goals = await listGoals();
        for (const goal of goals) {
          if (goal.title === title.trim()) {
            await store.forget(goal.id);
          }
        }
        const content = description?.trim()
          ? `${GOAL_PREFIX}${title.trim()}：${description.trim()}`
          : `${GOAL_PREFIX}${title.trim()}`;
        const entry = await store.add({ kind: 'semantic', content });
        return { ok: true, data: { entry } };
      },
    },
    {
      name: 'goal.list',
      description: '列出当前所有长期目标。会话开始或用户询问目标时调用。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      async execute() {
        const goals = await listGoals();
        return { ok: true, data: { count: goals.length, goals } };
      },
    },
    {
      name: 'goal.done',
      description: '移除一个长期目标（已完成或用户放弃）。可用 id 或 title 指定。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '目标 id（来自 goal.list）' },
          title: { type: 'string', description: '目标标题（来自 goal.list）' },
        },
        required: [],
      },
      permissionLevel: 1,
      async execute(input: unknown) {
        const { id, title } = (input ?? {}) as GoalDoneInput;
        const goals = await listGoals();
        if (id?.trim()) {
          if (!goals.some((goal) => goal.id === id)) {
            return { ok: false, error: '找不到该目标' };
          }
          await store.forget(id);
          return { ok: true, data: { done: id } };
        }
        if (title?.trim()) {
          const matched = goals.filter((goal) => goal.title === title.trim());
          if (matched.length === 0) return { ok: false, error: '找不到该目标' };
          for (const goal of matched) await store.forget(goal.id);
          return { ok: true, data: { done: matched.map((goal) => goal.id) } };
        }
        return { ok: false, error: '缺少 id 或 title 参数' };
      },
    },
  ];
}
