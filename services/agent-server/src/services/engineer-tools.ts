import type { EngineerTaskRunner } from './engineer-task-runner.js';
import {
  createColleagueDelegateTool,
  createColleagueStatusTool,
  type ColleagueMailboxGateway,
} from './colleague-tools.js';

export { XIAO_HEI_PROMPT, buildXiaoHeiTask } from './engineer-task-runner.js';

/**
 * engineer.delegate（异步版）：给小黑收件箱写信，把开发/修改代码的任务交给他。
 * 小黑有自己的持久会话记忆，不是一次性脚本。工具立即返回 taskId，dsh 在后台
 * 独立运行；小夜派完单就能继续陪用户聊天。进度与完成通过事件（SSE → 微信）
 * 主动推送；可用 engineer.status 查询状态/结果/收件箱。
 */
export function createEngineerTool(runner: EngineerTaskRunner, office?: ColleagueMailboxGateway) {
  return createColleagueDelegateTool({
    name: 'engineer.delegate',
    displayName: '小黑',
    statusToolName: 'engineer.status',
    runner,
    colleagueId: 'xiaohei',
    office,
    defaultTimeoutMinutes: 15,
    description:
      '给小黑发任务：把开发/修改代码的任务写到小黑的收件箱（他是独立的工程师同事，有自己的会话记忆，不是一次性脚本）。' +
      '小黑专业严肃：先调研、小步实现、自动跑 typecheck+test、输出结构化报告。' +
      '由私人助理（小夜）作为监督者调用；用户 CEO 把需求下达给助理后，由助理整理成任务写信派单。' +
      '这是异步任务：调用后立即返回 taskId（任务在后台运行，可继续与用户聊天），' +
      '进度与完成会自动通知，也可用 engineer.status 查询（含收件箱最近几封）。' +
      'directory 用 /app 等持久目录；耗时较长（30 秒到数分钟）。' +
      '轻量问题（查文件、看状态）不要用此工具，用 filesystem.search / server.shell / system.status 等轻量工具。',
  });
}

/**
 * engineer.status（L0 只读）：按 taskId 查询小黑任务状态/进度/结果；
 * 不传 taskId 时列出最近的任务，并附带收件箱最近 3 封。
 */
export function createEngineerStatusTool(
  runner: EngineerTaskRunner,
  office?: ColleagueMailboxGateway,
) {
  return createColleagueStatusTool({
    name: 'engineer.status',
    displayName: '小黑',
    runner,
    colleagueId: 'xiaohei',
    office,
  });
}
