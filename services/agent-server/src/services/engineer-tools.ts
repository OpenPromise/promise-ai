import type { EngineerTaskRunner } from './engineer-task-runner.js';
import {
  createColleagueDelegateTool,
  createColleagueStatusTool,
} from './colleague-tools.js';

export { XIAO_HEI_PROMPT, buildXiaoHeiTask } from './engineer-task-runner.js';

/**
 * engineer.delegate（异步版）：把开发/修改代码的任务派给"小黑"执行。
 * 工具立即创建后台任务并返回 taskId，dsh 在后台独立运行；小夜派完单
 * 就能继续陪用户聊天，不再被 15 分钟的子进程同步阻塞。进度与完成
 * 通过事件（SSE → 微信）主动推送；可用 engineer.status 查询状态/结果。
 */
export function createEngineerTool(runner: EngineerTaskRunner) {
  return createColleagueDelegateTool({
    name: 'engineer.delegate',
    displayName: '小黑',
    statusToolName: 'engineer.status',
    runner,
    defaultTimeoutMinutes: 15,
    description:
      '把开发/修改代码的任务派给"小黑"（专属工程师子代理）执行。' +
      '小黑是专业严肃的工程师：先调研、小步实现、自动跑 typecheck+test、输出结构化报告。' +
      '由私人助理（小夜）作为监督者调用；用户 CEO 把需求下达给助理后，由助理整理成任务派单。' +
      '这是异步任务：调用后立即返回 taskId（任务在后台运行，可继续与用户聊天），' +
      '进度与完成会自动通知，也可用 engineer.status 查询。' +
      'directory 用 /app 等持久目录；耗时较长（30 秒到数分钟）。' +
      '轻量问题（查文件、看状态）不要用此工具，用 filesystem.search / server.shell / system.status 等轻量工具。',
  });
}

/**
 * engineer.status（L0 只读）：按 taskId 查询小黑任务状态/进度/结果；
 * 不传 taskId 时列出最近的任务。
 */
export function createEngineerStatusTool(runner: EngineerTaskRunner) {
  return createColleagueStatusTool({
    name: 'engineer.status',
    displayName: '小黑',
    runner,
  });
}
