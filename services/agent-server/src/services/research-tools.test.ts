import { describe, expect, it } from 'vitest';
import { buildXiaoZhiTask, createResearchTool, XIAO_ZHI_COLLEAGUE } from './research-tools.js';
import { ColleagueTaskRunner } from './colleague-task-runner.js';
import type { RunTaskFn } from './colleague-task-runner.js';

async function waitForStatus(
  runner: { get: (id: string) => { status: string } | undefined },
  id: string,
  timeoutMs = 200,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = runner.get(id)?.status;
    if (status && status !== 'running') return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return runner.get(id)?.status;
}

function makeRunner(runTask: RunTaskFn) {
  return new ColleagueTaskRunner(XIAO_ZHI_COLLEAGUE, { runTask, progressIntervalMs: 0 });
}

describe('buildXiaoZhiTask', () => {
  it('任务单包含小知人格关键词与研究工作流元素', () => {
    const request = '调研 MiniMax 视频接口 v1 到 v2 的迁移要点';
    const task = buildXiaoZhiTask(request);
    expect(task).toContain('小知');
    expect(task).toContain('结论先行');
    expect(task).toContain('来源');
    expect(task).toContain('置信度');
    expect(task).toContain('监督者');
    expect(task).toContain('交叉验证');
    expect(task).toContain('xiaozhi');
    expect(task).toContain('AGENTS.md');
    expect(task).toContain('【问题】');
    expect(task).toContain('【结论】');
    expect(task).toContain('【证据与来源】');
    expect(task).toContain('【未验证假设】');
    expect(task).toContain('【沉淀位置】');
    expect(task).toContain(request);
  });
});

describe('createResearchTool', () => {
  it('返回 research.delegate 工具：L1 权限、task 必填', () => {
    const tool = createResearchTool(makeRunner(async () => ({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 })));
    expect(tool.name).toBe('research.delegate');
    expect(tool.permissionLevel).toBe(1);
    const schema = tool.inputSchema as { required?: string[] };
    expect(schema.required).toContain('task');
  });

  it('execute 缺 task 时返回 ok:false 且 error 含 task（不触达 dsh）', async () => {
    let called = false;
    const tool = createResearchTool(
      makeRunner(async () => {
        called = true;
        return { stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 };
      }),
    );
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('task');
    expect(called).toBe(false);
  });

  it('异步派单立即返回 taskId，并以 workspace-write 运行', async () => {
    let mode: string | undefined;
    const runner = makeRunner(async (_text, options) => {
      mode = options.permissionMode;
      return {
        stdout: '【问题】…\n【结论】v2 使用多模态 content 数组',
        stderr: '',
        timedOut: false,
        exitCode: 0,
      };
    });
    const tool = createResearchTool(runner);
    const result = await tool.execute({ task: '调研接口', directory: process.cwd() }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    const taskId = (result.data as { taskId: string }).taskId;
    await waitForStatus(runner, taskId);
    expect(mode).toBe('workspace-write');
    expect(runner.get(taskId)?.result).toContain('content 数组');
  });
});
