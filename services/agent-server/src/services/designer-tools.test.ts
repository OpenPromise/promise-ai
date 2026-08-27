import { describe, expect, it } from 'vitest';
import {
  buildXiaoMeiTask,
  createDesignerStatusTool,
  createDesignerTool,
  XIAO_MEI_COLLEAGUE,
} from './designer-tools.js';
import { ColleagueTaskRunner } from './colleague-task-runner.js';
import { DSH_NOT_FOUND_MESSAGE } from './coding-tool.js';
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
  return new ColleagueTaskRunner(XIAO_MEI_COLLEAGUE, { runTask, progressIntervalMs: 0 });
}

describe('buildXiaoMeiTask', () => {
  it('任务单包含小美人格关键词与 DESIGN_SPEC 契约元素', () => {
    const request = '给登录页做一版新的 UI 设计，重点优化注册转化';
    const task = buildXiaoMeiTask(request);
    expect(task).toContain('小美');
    expect(task).toContain('设计');
    expect(task).toContain('UX');
    expect(task).toContain('不炫技');
    expect(task).toContain('用户任务优先');
    expect(task).toContain('DESIGN_SPEC');
    expect(task).toContain('Visual QA');
    expect(task).toContain('UX 先行');
    expect(task).toContain('Design System');
    expect(task).toContain('小黑');
    expect(task).toContain('权限边界');
    expect(task).toContain('监督者');
    expect(task).toContain('【目标】');
    expect(task).toContain('【UX 分析】');
    expect(task).toContain('【视觉方向】');
    expect(task).toContain('【风险与建议】');
    expect(task).toContain(request);
  });
});

describe('createDesignerTool', () => {
  it('返回 designer.delegate 工具：L1 权限、task 必填', () => {
    const tool = createDesignerTool(makeRunner(async () => ({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 })));
    expect(tool.name).toBe('designer.delegate');
    expect(tool.permissionLevel).toBe(1);
    const schema = tool.inputSchema as { required?: string[] };
    expect(schema.required).toContain('task');
  });

  it('execute 缺 task 时返回 ok:false 且 error 含 task（不触达 dsh）', async () => {
    const tool = createDesignerTool(makeRunner(async () => ({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 })));
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('task');
  });

  it('execute task 为空字符串时同样校验失败', async () => {
    const tool = createDesignerTool(makeRunner(async () => ({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 })));
    const result = await tool.execute({ task: '   ' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('task');
  });

  it('directory 不存在时返回可读错误（不触达 dsh）', async () => {
    const tool = createDesignerTool(makeRunner(async () => ({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 })));
    const result = await tool.execute(
      { task: '设计一个设置页', directory: '/nonexistent-dir-for-designer-tool-test' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('目录不存在');
  });

  it('有效任务立即返回 taskId；失败/超时经 designer.status 可见', async () => {
    const runner = makeRunner(async () => ({
      stdout: '',
      stderr: DSH_NOT_FOUND_MESSAGE,
      timedOut: false,
      exitCode: 1,
    }));
    const tool = createDesignerTool(runner);
    const result = await tool.execute(
      { task: '梳理首页信息架构', directory: process.cwd() },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    const taskId = (result.data as { taskId: string }).taskId;
    await waitForStatus(runner, taskId);
    const status = await createDesignerStatusTool(runner).execute({ taskId }, { sessionId: 's1' });
    expect((status.data as { error?: string }).error).toContain('@deepseek-ai/dsh');
  });

  it('成功时后台结果可查，并以 workspace-write 驱动 dsh', async () => {
    let mode: string | undefined;
    const runner = makeRunner(async (_text, options) => {
      mode = options.permissionMode;
      return {
        stdout: '【UX 分析】目标用户是新注册用户……\n【DESIGN_SPEC】--color-primary: #50e5fb',
        stderr: '',
        timedOut: false,
        exitCode: 0,
      };
    });
    const tool = createDesignerTool(runner);
    const result = await tool.execute({ task: '设计注册页', directory: process.cwd() }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    const taskId = (result.data as { taskId: string }).taskId;
    await waitForStatus(runner, taskId);
    expect(mode).toBe('workspace-write');
    const status = await createDesignerStatusTool(runner).execute({ taskId }, { sessionId: 's1' });
    expect((status.data as { result?: string }).result).toContain('【DESIGN_SPEC】');
  });

  it('执行超时经 status 返回 timeout', async () => {
    const runner = makeRunner(async () => ({
      stdout: '',
      stderr: '',
      timedOut: true,
      exitCode: 124,
    }));
    const tool = createDesignerTool(runner);
    const result = await tool.execute({ task: '设计首页', directory: process.cwd() }, { sessionId: 's1' });
    const taskId = (result.data as { taskId: string }).taskId;
    await waitForStatus(runner, taskId);
    expect(runner.get(taskId)?.status).toBe('timeout');
    expect(runner.get(taskId)?.error).toContain('被终止');
  });
});
