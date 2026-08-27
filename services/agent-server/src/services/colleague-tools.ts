import path from 'node:path';
import { access } from 'node:fs/promises';
import type { PermissionLevel, Tool, ToolResult } from '@personal-ai/tools';
import type { ColleagueTaskRunner } from './colleague-task-runner.js';

interface DelegateInput {
  task?: string;
  directory?: string;
  timeoutMinutes?: number;
}

export interface ColleagueDelegateToolOptions {
  name: string;
  description: string;
  displayName: string;
  statusToolName: string;
  runner: ColleagueTaskRunner;
  defaultDirectory?: string;
  defaultTimeoutMinutes?: number;
}

/**
 * 通用 *.delegate：立即创建后台任务并返回 taskId，dsh 由 ColleagueTaskRunner
 * 在后台跑。各同事工具只提供名字、描述、默认超时，共用这份实现。
 */
export function createColleagueDelegateTool(options: ColleagueDelegateToolOptions): Tool {
  const defaultDirectory = options.defaultDirectory ?? '/app';
  const defaultTimeoutMinutes = options.defaultTimeoutMinutes ?? 15;
  const { displayName, statusToolName, runner } = options;
  return {
    name: options.name,
    description: options.description,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: `要${displayName}完成的任务描述（越具体越好）` },
        directory: {
          type: 'string',
          description: '工作目录绝对路径，默认 /app（bind mount 持久目录）',
        },
        timeoutMinutes: {
          type: 'number',
          minimum: 1,
          maximum: 60,
          description: `等待上限（分钟），默认 ${defaultTimeoutMinutes}`,
        },
      },
      required: ['task'],
    },
    permissionLevel: 1 as PermissionLevel,
    timeoutMs: 30_000,
    async execute(input: unknown): Promise<ToolResult> {
      const {
        task,
        directory = defaultDirectory,
        timeoutMinutes = defaultTimeoutMinutes,
      } = (input ?? {}) as DelegateInput;
      if (!task?.trim()) {
        return { ok: false, error: '缺少 task 参数' };
      }
      const resolvedDir = path.resolve(directory);
      try {
        await access(resolvedDir);
      } catch {
        return { ok: false, error: `目录不存在：${resolvedDir}` };
      }
      if (task.trim().length > 20_000) {
        return { ok: false, error: '任务文本超过 20000 字符，请拆分任务后重试' };
      }
      const record = await runner.delegate(task.trim(), {
        directory: resolvedDir,
        timeoutMinutes,
      });
      return {
        ok: true,
        data: {
          taskId: record.id,
          status: record.status,
          note:
            `已派出给${displayName}，任务 ${record.id.slice(0, 8)} 正在后台运行；` +
            `完成会自动通知，也可以用 ${statusToolName} 查询。`,
        },
      };
    },
  };
}

export interface ColleagueStatusToolOptions {
  name: string;
  displayName: string;
  runner: ColleagueTaskRunner;
}

/**
 * 通用 *.status（L0 只读）：按 taskId 查询同事后台任务；不传则列出最近任务。
 */
export function createColleagueStatusTool(options: ColleagueStatusToolOptions): Tool {
  const { name, displayName, runner } = options;
  return {
    name,
    description:
      `查询${displayName}后台任务的状态（只读 L0）：按 taskId 返回该任务的进度、` +
      `最终结果或失败原因；不传 taskId 时列出最近 10 个任务。` +
      `用户问"${displayName}任务怎么样了/完成了吗"时使用。`,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: `任务 ID（对应 *.delegate 返回的 taskId），省略则列出最近任务`,
        },
      },
      required: [],
    },
    permissionLevel: 0,
    async execute(input: unknown): Promise<ToolResult> {
      const { taskId } = (input ?? {}) as { taskId?: string };
      if (taskId?.trim()) {
        const record = runner.get(taskId.trim());
        if (!record) {
          return {
            ok: false,
            error: `找不到任务 ${taskId.trim().slice(0, 8)}，可能已过期或从未存在`,
          };
        }
        return {
          ok: true,
          data: {
            taskId: record.id,
            colleague: record.colleague ?? displayName,
            status: record.status,
            task: record.task.slice(0, 200),
            directory: record.directory,
            progress: record.progress,
            result: record.result,
            error: record.error,
            createdAt: record.createdAt,
            finishedAt: record.finishedAt,
          },
        };
      }
      const tasks = runner.list(10).map((record) => ({
        taskId: record.id,
        colleague: record.colleague ?? displayName,
        status: record.status,
        task: record.task.slice(0, 120),
        progress: record.progress,
        finishedAt: record.finishedAt,
      }));
      return {
        ok: true,
        data: { count: tasks.length, tasks },
      };
    },
  };
}
