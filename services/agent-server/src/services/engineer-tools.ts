import path from 'node:path';
import { access } from 'node:fs/promises';
import type { PermissionLevel, Tool, ToolResult } from '@personal-ai/tools';
import {
  buildXiaoHeiTask,
  EngineerTaskRunner,
  XIAO_HEI_PROMPT,
} from './engineer-task-runner.js';

export { XIAO_HEI_PROMPT, buildXiaoHeiTask };

interface EngineerInput {
  task?: string;
  directory?: string;
  timeoutMinutes?: number;
}

/**
 * engineer.delegate（异步版）：把开发/修改代码的任务派给"小黑"执行。
 * 工具立即创建后台任务并返回 taskId，dsh 在后台独立运行；小夜派完单
 * 就能继续陪用户聊天，不再被 15 分钟的子进程同步阻塞。进度与完成
 * 通过事件（SSE → 微信）主动推送；可用 engineer.status 查询状态/结果。
 */
export function createEngineerTool(runner: EngineerTaskRunner): Tool {
  return {
    name: 'engineer.delegate',
    description:
      '把开发/修改代码的任务派给"小黑"（专属工程师子代理）执行。' +
      '小黑是专业严肃的工程师：先调研、小步实现、自动跑 typecheck+test、输出结构化报告。' +
      '由私人助理（小夜）作为监督者调用；用户 CEO 把需求下达给助理后，由助理整理成任务派单。' +
      '这是异步任务：调用后立即返回 taskId（任务在后台运行，可继续与用户聊天），' +
      '进度与完成会自动通知，也可用 engineer.status 查询。' +
      'directory 用 /app 等持久目录；耗时较长（30 秒到数分钟）。' +
      '轻量问题（查文件、看状态）不要用此工具，用 filesystem/terminal 等轻量工具。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要小黑完成的开发任务描述（用户需求，越具体越好）' },
        directory: {
          type: 'string',
          description: '项目目录绝对路径，默认 /app（bind mount 持久目录）',
        },
        timeoutMinutes: {
          type: 'number',
          minimum: 1,
          maximum: 60,
          description: '等待上限（分钟），默认 15',
        },
      },
      required: ['task'],
    },
    permissionLevel: 1 as PermissionLevel,
    timeoutMs: 30_000,
    async execute(input: unknown): Promise<ToolResult> {
      const { task, directory = '/app', timeoutMinutes = 15 } = (input ?? {}) as EngineerInput;
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
          note: `已派出给小黑，任务 ${record.id.slice(0, 8)} 正在后台运行；完成会自动通知，也可以用 engineer.status 查询。`,
        },
      };
    },
  };
}

/**
 * engineer.status（L0 只读）：按 taskId 查询小黑任务状态/进度/结果；
 * 不传 taskId 时列出最近的任务。
 */
export function createEngineerStatusTool(runner: EngineerTaskRunner): Tool {
  return {
    name: 'engineer.status',
    description:
      '查询小黑后台任务的状态（只读 L0）：按 taskId 返回该任务的进度、' +
      '最终结果或失败原因；不传 taskId 时列出最近 10 个任务。' +
      '用户问"小黑任务怎么样了/完成了吗"时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: '任务 ID（engineer.delegate 返回的 taskId），省略则列出最近任务',
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
          return { ok: false, error: `找不到任务 ${taskId.trim().slice(0, 8)}，可能已过期或从未存在` };
        }
        return {
          ok: true,
          data: {
            taskId: record.id,
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
