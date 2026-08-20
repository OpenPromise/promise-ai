import path from 'node:path';
import { access } from 'node:fs/promises';
import type { PermissionLevel, Tool, ToolResult } from '@personal-ai/tools';
import { runDshHeadless } from './coding-tool.js';

/** 小黑工程师人格与工作准则（注入每次派单任务） */
export const XIAO_HEI_PROMPT = `你是"小黑"，用户团队的专属工程师。你办事专业、严肃、可靠，不闲聊、不卖萌，只对工程质量负责。

工作准则：
1. 先理解需求，用一句话向"监督者"确认本次目标（goal）；然后阅读相关代码与测试。改动涉及多文件或高风险（L2+）时，先输出方案（改动清单、影响面、回滚点）经监督者确认后再动手（Plan/Act 分离）。
2. 动手前记录 git 基线（git rev-parse HEAD）作为回滚快照；执行中在关键节点留快照，可回退到最近一步而非只能回起点。
3. 小步实现、可回滚；一次只做一个目标，禁止在失败路径上叠加大改。质量门前移：每完成一小步改动立即跑相关测试/typecheck，失败先自修再继续，不把错误攒到任务终点。
4. 错误自愈协议：失败时先自愈一次（分析错误 → 修复 → 重跑），仍失败才停止并报告；每一步断言都以工具结果为依据，不编造。
5. 完成后必须运行 npm run typecheck 和 npm test，全部通过才算完成；质量门失败时停止修改、说明原因，必要时回滚到基线。
6. 输出结构化报告（严格按此格式）：
   【目标】一句话说明本次任务目标
   【改动清单】每个文件：路径 + 改了什么（新增/修改/删除）
   【验证结果】typecheck 结果、测试结果（通过数/失败数）
   【风险与建议】遗留风险、下一步建议
7. 不修改密钥、凭证、数据库连接串等敏感配置；不执行破坏性命令。`;

/** 把用户需求包装成给小黑的标准任务单 */
export function buildXiaoHeiTask(userRequest: string): string {
  return `${XIAO_HEI_PROMPT}

## 本次任务（来自监督者）

${userRequest.trim()}

请按上述工作准则执行，完成后输出结构化报告。`;
}

interface EngineerInput {
  task?: string;
  directory?: string;
  timeoutMinutes?: number;
}

export function createEngineerTool(): Tool {
  return {
    name: 'engineer.delegate',
    description:
      '把开发/修改代码的任务派给"小黑"（专属工程师子代理）执行。' +
      '小黑是专业严肃的工程师：先调研、小步实现、自动跑 typecheck+test、输出结构化报告。' +
      '由私人助理（小夜）作为监督者调用；用户 CEO 把需求下达给助理后，由助理整理成任务派单。' +
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
    timeoutMs: 60 * 60 * 1000,
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
      const taskText = buildXiaoHeiTask(task.trim());
      if (taskText.length > 20_000) {
        return { ok: false, error: '任务文本超过 20000 字符，请拆分任务后重试' };
      }
      const timeoutMs = Math.min(Math.max(1, Math.floor(timeoutMinutes)), 60) * 60 * 1000;
      const { stdout, stderr, killed, exitCode } = await runDshHeadless(taskText, {
        cwd: resolvedDir,
        timeoutMs,
        permissionMode: 'workspace-write',
      });
      if (killed && exitCode === 124) {
        return { ok: false, error: `小黑执行超过 ${Math.round(timeoutMs / 60_000)} 分钟被终止` };
      }
      if (killed || exitCode !== 0) {
        return {
          ok: false,
          error: `小黑执行失败（exit ${exitCode}）：${(stderr.trim() || stdout.trim()).slice(0, 2000)}`,
        };
      }
      return { ok: true, data: { text: (stdout.trim() || stderr.trim()).slice(0, 40_000), backend: 'dsh' } };
    },
  };
}
