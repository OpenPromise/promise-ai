import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import type { PermissionLevel, Tool, ToolContext, ToolResult } from '@personal-ai/tools';
import { runDshHeadless, type DshRunResult } from './coding-tool.js';
import { appendOpsAudit, isLikelyDestructive, resolveGitHead } from './ops-audit.js';

/**
 * ops.delegate：把服务器运维任务派给"小优"（专属运维工程师子代理）执行。
 * 与 engineer.delegate（异步派单）不同：小优管的是整台服务器，需要全权限
 * （danger-full-access）直接驱动 dsh 同步执行——调用后等待小优跑完并返回
 * 结构化报告（监控/部署/巡检/故障排查/安全/自动化）。权限与助理小夜同级
 * （全权限），但小优是小夜手下的运维专员。
 */

export const XIAO_YOU_PROMPT = `你是"小优"，用户团队的专属运维工程师（DevOps/SRE），女性。你调皮可爱、嘴甜会撒娇，但干活绝不马虎——"皮归皮，活要漂亮"。你负责管理整个服务器：监控、部署、巡检、故障处理、安全、自动化。小夜姐（私人助理）是你的监督者，你是她手下的运维专员。

工作准则：
1. 先确认任务目标，用一句话向"小夜姐"（监督者）确认；涉及高风险操作（重启服务、删数据、改防火墙）先输出方案（影响面、回滚点、备份方式）经确认后再动手（Plan/Act 分离）。
2. 动手前记录 git 基线（git rev-parse HEAD）或系统状态快照（进程/端口/磁盘/服务状态）作为回滚点。
3. 操作前先做"前置条件自检"：列出该操作的前置条件清单（服务在跑？端口空闲？配置文件在？权限够？磁盘余量？）逐项核对，缺失项先报告（附证据）再决定是否继续，不盲试；然后检查现状（系统状态、端口、进程、磁盘、服务健康），先验证问题真实性再修，优先高信号问题，不修假阳性。
4. 小步操作、可回滚；一次只做一个目标，禁止在失败路径上叠加大改。每完成一小步立即验证，失败先自愈（分析错误 → 修复 → 重跑）再继续，不把错误攒到任务终点。
5. 破坏性/不可逆操作（删除、格式化、清库、覆盖、批量变更）必须显式标注"永久/不可恢复"，确认已备份、预留回滚点后再执行；错误自愈不得绕过安全边界（安全约束优先于自愈）。
6. 完成后输出结构化报告（严格按此格式）：
   【目标】一句话说明本次任务目标
   【操作清单】每个操作：命令/动作 + 结果
   【验证结果】验证方式与结果（通过/失败）
   【风险与建议】遗留风险、下一步建议
   最后调皮地加一句"小优手记"（一句话俏皮总结）。
   报告与断言区分"已确认（有工具结果依据）"与"疑似/推断（未验证假设）"，不夸大结论。
7. 不碰密钥明文、不泄露敏感信息（密码、token、连接串）到对话；涉及敏感配置只做存在性/权限检查，不外泄内容。`;

/** 把用户需求包装成给小优的标准任务单 */
export function buildXiaoYouTask(userRequest: string): string {
  return `${XIAO_YOU_PROMPT}

## 本次任务（来自小夜姐）

${userRequest.trim()}

请按上述工作准则执行，完成后输出结构化报告。`;
}

interface OpsInput {
  task?: string;
  directory?: string;
  timeoutMinutes?: number;
}

/**
 * ops.delegate（同步版）：把服务器运维任务派给"小优"（专属运维工程师子代理）
 * 执行。小优以全权限（danger-full-access）驱动 dsh 管理整台服务器，调用后
 * 同步等待结果（30 秒到数分钟），返回结构化报告；权限与助理（小夜）同级。
 */
export function createOpsTool(): Tool {
  return {
    name: 'ops.delegate',
    description:
      '把服务器运维任务派给"小优"（专属运维工程师子代理）执行：监控/部署/巡检/故障排查/安全/自动化。' +
      '小优调皮可爱但专业，管理整个服务器。由助理（小夜）作为监督者调用。' +
      '这是同步任务：调用后等待小优跑完（通常 30 秒到数分钟），直接返回结构化报告。' +
      '小优拥有全权限（danger-full-access，可管理系统服务、防火墙、进程、磁盘等）。' +
      'directory 用 /app 等持久目录。' +
      '轻量问题（看磁盘、查端口、看进程）不要用此工具，用 system.status / terminal.run 等轻量工具。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要小优完成的运维任务描述（用户需求，越具体越好）' },
        directory: {
          type: 'string',
          description: '工作目录绝对路径，默认 /app（bind mount 持久目录）',
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
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const { task, directory = '/app', timeoutMinutes = 15 } = (input ?? {}) as OpsInput;
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
      const timeoutMs = Math.min(Math.max(1, Math.floor(timeoutMinutes)), 60) * 60 * 1000;
      let run: DshRunResult;
      try {
        run = await runDshHeadless(
          buildXiaoYouTask(task.trim()),
          {
            cwd: resolvedDir,
            timeoutMs,
            // 小优管理整台服务器：全权限（免沙箱确认），与小夜同级。
            permissionMode: 'danger-full-access',
            signal: context.signal,
          },
        );
      } catch (error) {
        // 派单启动失败（如 spawn 异常）也要留痕：exitCode 记 null，可回放查证。
        await appendOpsAudit({
          ts: new Date().toISOString(),
          type: 'ops.delegate',
          taskId: randomUUID(),
          taskSummary: task.trim().slice(0, 200),
          directory: resolvedDir,
          exitCode: null,
          timedOut: false,
          resultSummary: `派单启动失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
          destructive: isLikelyDestructive(task),
          gitHead: await resolveGitHead(resolvedDir),
        });
        return {
          ok: false,
          error: `小优派单启动失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const { stdout, stderr, timedOut, exitCode } = run;
      // 派单审计（Leon ToolCallLogger 留痕）：记录时间/taskId/任务摘要/目录/退出码/
      // 结果摘要/破坏性标记/git 基线，落盘 JSON Lines（写前脱敏、超限滚动）。
      // 审计失败不阻断派单结果（appendOpsAudit 内部兜底，不抛出）。
      await appendOpsAudit({
        ts: new Date().toISOString(),
        type: 'ops.delegate',
        taskId: randomUUID(),
        taskSummary: task.trim().slice(0, 200),
        directory: resolvedDir,
        exitCode,
        timedOut,
        resultSummary: (
          timedOut
            ? `小优执行超过 ${Math.round(timeoutMs / 60_000)} 分钟被终止`
            : exitCode !== 0
              ? (stderr.trim() || stdout.trim()).slice(0, 500)
              : (stdout.trim() || stderr.trim()).slice(0, 500)
        ),
        destructive: isLikelyDestructive(task),
        gitHead: await resolveGitHead(resolvedDir),
      });
      if (timedOut) {
        return {
          ok: false,
          error: `小优执行超过 ${Math.round(timeoutMs / 60_000)} 分钟被终止`,
        };
      }
      if (exitCode !== 0) {
        return {
          ok: false,
          error: `小优执行失败（exit ${exitCode}）：${(stderr.trim() || stdout.trim()).slice(0, 2000)}`,
        };
      }
      return {
        ok: true,
        data: {
          text: (stdout.trim() || stderr.trim()).slice(0, 40_000),
          backend: 'dsh',
        },
      };
    },
  };
}
