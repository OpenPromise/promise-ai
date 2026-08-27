import {
  ColleagueTaskRunner,
  type ColleagueSpec,
  type ColleagueTask,
  type ColleagueFinishOutcome,
  type ColleagueTaskRunnerOptions,
} from './colleague-task-runner.js';
import {
  createColleagueDelegateTool,
  createColleagueStatusTool,
} from './colleague-tools.js';
import { appendOpsAudit, isLikelyDestructive, resolveGitHead } from './ops-audit.js';

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

export const XIAO_YOU_COLLEAGUE: ColleagueSpec = {
  id: 'ops',
  name: '小优',
  permissionMode: 'danger-full-access',
  buildTask: buildXiaoYouTask,
  startedText: '小优已开工，正在执行任务',
  persistFileName: 'ops-tasks.json',
};

/** 小优 runner：在通用异步执行器上挂运维审计（Leon ToolCallLogger 留痕）。 */
export function createOpsTaskRunner(
  options: ColleagueTaskRunnerOptions = {},
): ColleagueTaskRunner {
  const userOnFinish = options.onFinish;
  return new ColleagueTaskRunner(XIAO_YOU_COLLEAGUE, {
    ...options,
    onFinish: async (task: ColleagueTask, outcome: ColleagueFinishOutcome) => {
      await appendOpsAudit({
        ts: new Date().toISOString(),
        type: 'ops.delegate',
        taskId: task.id,
        taskSummary: task.task.slice(0, 200),
        directory: task.directory,
        exitCode: outcome.exitCode ?? null,
        timedOut: outcome.status === 'timeout',
        resultSummary: (outcome.error ?? outcome.result ?? '').slice(0, 500),
        destructive: isLikelyDestructive(task.task),
        gitHead: await resolveGitHead(task.directory),
      });
      await userOnFinish?.(task, outcome);
    },
  });
}

export function createOpsTool(runner: ColleagueTaskRunner) {
  return createColleagueDelegateTool({
    name: 'ops.delegate',
    displayName: '小优',
    statusToolName: 'ops.status',
    runner,
    defaultTimeoutMinutes: 15,
    description:
      '把服务器运维任务派给"小优"（专属运维工程师子代理）执行：监控/部署/巡检/故障排查/安全/自动化。小优调皮可爱但专业，管理整个服务器。由助理（小夜）作为监督者调用。这是异步任务：调用后立即返回 taskId（任务在后台运行，可继续与用户聊天），进度与完成会自动通知，也可用 ops.status 查询。小优拥有全权限（danger-full-access，可管理系统服务、防火墙、进程、磁盘等）。directory 用 /app 等持久目录。轻量问题（看磁盘、查端口、看进程、问现在几点）不要用此工具，用 system.status / server.shell 等轻量工具。',
  });
}

export function createOpsStatusTool(runner: ColleagueTaskRunner) {
  return createColleagueStatusTool({
    name: 'ops.status',
    displayName: '小优',
    runner,
  });
}
