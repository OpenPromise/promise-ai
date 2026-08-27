import path from 'node:path';
import { access } from 'node:fs/promises';
import type { PermissionLevel, Tool, ToolContext, ToolResult } from '@personal-ai/tools';
import type { ColleagueTask, ColleagueTaskRunner } from './colleague-task-runner.js';

interface DelegateInput {
  task?: string;
  directory?: string;
  timeoutMinutes?: number;
}

export interface ColleagueMailPreview {
  id: string;
  subject: string;
  status: string;
  createdAt: string;
  taskId?: string;
}

/** 同事办公室端口：工具层可选接入，不强制所有 runner 测试走收件箱。 */
export interface ColleagueMailboxGateway {
  delegate(
    colleagueId: string,
    task: string,
    options?: { directory?: string; timeoutMinutes?: number; hubSessionId?: string },
  ): Promise<ColleagueTask>;
  recentMail(colleagueId: string, limit?: number): ColleagueMailPreview[];
  getTask?(id: string): ColleagueTask | undefined;
  listTasks?(limit?: number): ColleagueTask[];
}

export interface ColleagueDelegateToolOptions {
  name: string;
  description: string;
  displayName: string;
  statusToolName: string;
  runner: ColleagueTaskRunner;
  defaultDirectory?: string;
  defaultTimeoutMinutes?: number;
  colleagueId?: string;
  office?: ColleagueMailboxGateway;
}

/**
 * 通用 *.delegate：立即创建后台任务并返回 taskId。接入办公室时写信到该同事
 * 收件箱，由同事自己的持久会话 headless 思考（工具白名单动手）；未接入时回退
 * ColleagueTaskRunner（dsh）。
 */
export function createColleagueDelegateTool(options: ColleagueDelegateToolOptions): Tool {
  const defaultDirectory = options.defaultDirectory ?? '/app';
  const defaultTimeoutMinutes = options.defaultTimeoutMinutes ?? 15;
  const { displayName, statusToolName, runner, office, colleagueId } = options;
  return {
    name: options.name,
    description: options.description,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: `写给${displayName}收件箱的任务（越具体越好）` },
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
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
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
      const hubSessionId =
        typeof context?.sessionId === 'string' ? context.sessionId.trim() : '';
      const record =
        office && colleagueId
          ? await office.delegate(colleagueId, task.trim(), {
              directory: resolvedDir,
              timeoutMinutes,
              ...(hubSessionId ? { hubSessionId } : {}),
            })
          : await runner.delegate(task.trim(), {
              directory: resolvedDir,
              timeoutMinutes,
            });
      return {
        ok: true,
        data: {
          taskId: record.id,
          status: record.status,
          note:
            `已写信给${displayName}收件箱，任务 ${record.id.slice(0, 8)} 正在后台运行；` +
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
  colleagueId?: string;
  office?: ColleagueMailboxGateway;
}

function mergeTaskLists(
  runner: ColleagueTaskRunner,
  office: ColleagueMailboxGateway | undefined,
  limit: number,
): ColleagueTask[] {
  const merged = new Map<string, ColleagueTask>();
  for (const record of office?.listTasks?.(limit) ?? []) {
    merged.set(record.id, record);
  }
  for (const record of runner.list(limit)) {
    merged.set(record.id, record);
  }
  return [...merged.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, Math.floor(limit)));
}

/**
 * 通用 *.status（L0 只读）：按 taskId 查询同事后台任务；不传则列出最近任务。
 * 接入办公室时附带收件箱最近 3 封主题/状态；会话路径任务走 office.getTask。
 */
export function createColleagueStatusTool(options: ColleagueStatusToolOptions): Tool {
  const { name, displayName, runner, office, colleagueId } = options;
  return {
    name,
    description:
      `查询${displayName}后台任务与收件箱（只读 L0）：按 taskId 返回该任务的进度、` +
      `最终结果或失败原因；不传 taskId 时列出最近 10 个任务，并附带收件箱最近 3 封（主题/状态）。` +
      `用户问"${displayName}任务怎么样了/收件箱还有没有在跑"时使用。`,
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
      const mailbox =
        office && colleagueId ? office.recentMail(colleagueId, 3) : undefined;
      if (taskId?.trim()) {
        const record = runner.get(taskId.trim()) ?? office?.getTask?.(taskId.trim());
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
            ...(mailbox ? { mailbox } : {}),
          },
        };
      }
      const tasks = mergeTaskLists(runner, office, 10).map((record) => ({
        taskId: record.id,
        colleague: record.colleague ?? displayName,
        status: record.status,
        task: record.task.slice(0, 120),
        progress: record.progress,
        finishedAt: record.finishedAt,
      }));
      return {
        ok: true,
        data: { count: tasks.length, tasks, ...(mailbox ? { mailbox } : {}) },
      };
    },
  };
}
