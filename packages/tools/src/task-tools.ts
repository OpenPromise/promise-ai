import type { TaskStore } from '@personal-ai/memory';
import type { Tool } from './index.js';

export interface TaskToolDeps {
  tasks: TaskStore;
  /** Creates a dedicated session for a new task and returns its id. */
  createTaskSession(action: string): Promise<string>;
  /** Validates a cron expression; returns an error message or null. */
  validateSchedule(schedule: string): string | null;
}

interface CreateTaskInput {
  name: string;
  schedule: string;
  action: string;
  tools?: string[];
}

interface ListRunsInput {
  taskId?: string;
  limit?: number;
}

export function createTaskTools(deps: TaskToolDeps): Tool[] {
  return [
    {
      name: 'task.create',
      description:
        '创建一个定时任务：到指定 cron 时间后由 AI 自动执行 action 指令（无人值守，只能使用无需确认的工具）。schedule 为标准 5 段 cron，如 "0 9 * * *"（每天 9 点）。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '任务名称' },
          schedule: { type: 'string', description: 'cron 表达式，如 "0 9 * * *"' },
          action: {
            type: 'string',
            description: '要 AI 自动执行的指令，如：检查杭州天气，如果下雨提醒我',
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description:
              '允许使用的工具白名单（可选）：如 ["system.status","server.shell"]；' +
              '缺省允许全部工具',
          },
        },
        required: ['name', 'schedule', 'action'],
      },
      permissionLevel: 1,
      async execute(input: unknown) {
        const { name, schedule, action, tools } = (input ?? {}) as CreateTaskInput;
        if (!name?.trim() || !schedule?.trim() || !action?.trim()) {
          return { ok: false, error: '缺少 name / schedule / action 参数' };
        }
        const scheduleError = deps.validateSchedule(schedule.trim());
        if (scheduleError) {
          return { ok: false, error: scheduleError };
        }
        const sessionId = await deps.createTaskSession(action.trim());
        const toolsWhitelist = Array.isArray(tools)
          ? [...new Set(tools.map((tool) => tool.trim()).filter(Boolean))]
          : undefined;
        const task = await deps.tasks.createTask({
          name: name.trim(),
          schedule: schedule.trim(),
          action: action.trim(),
          sessionId,
          ...(toolsWhitelist && toolsWhitelist.length > 0 ? { tools: toolsWhitelist } : {}),
        });
        return { ok: true, data: { task } };
      },
    },
    {
      name: 'task.list',
      description: '列出所有定时任务。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      permissionLevel: 0,
      async execute() {
        const tasks = await deps.tasks.listTasks();
        return { ok: true, data: { count: tasks.length, tasks } };
      },
    },
    {
      name: 'task.delete',
      description: '删除一个定时任务（L2：需要用户确认）。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id' },
        },
        required: ['id'],
      },
      permissionLevel: 2,
      async execute(input: unknown) {
        const { id } = (input ?? {}) as { id?: string };
        if (!id?.trim()) {
          return { ok: false, error: '缺少 id 参数' };
        }
        const deleted = await deps.tasks.deleteTask(id);
        if (!deleted) {
          return { ok: false, error: '找不到该任务' };
        }
        return { ok: true, data: { deleted: id } };
      },
    },
    {
      name: 'task.list-runs',
      description: '查看定时任务的执行记录（最近 50 条，可按任务过滤）。',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务 id（可选）' },
          limit: { type: 'number', description: '返回条数，默认 50' },
        },
        required: [],
      },
      permissionLevel: 0,
      async execute(input: unknown) {
        const { taskId, limit } = (input ?? {}) as ListRunsInput;
        const runs = await deps.tasks.listRuns(taskId, limit);
        return { ok: true, data: { count: runs.length, runs } };
      },
    },
  ];
}
