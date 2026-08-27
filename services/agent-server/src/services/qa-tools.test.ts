import { describe, expect, it } from 'vitest';
import { buildXiaoZhenTask, createQaTool, XIAO_ZHEN_COLLEAGUE } from './qa-tools.js';
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
  return new ColleagueTaskRunner(XIAO_ZHEN_COLLEAGUE, { runTask, progressIntervalMs: 0 });
}

describe('buildXiaoZhenTask', () => {
  it('任务单包含小真人格关键词与验收工作流元素', () => {
    const request = '验收官网改版：构建、资源可访问性、成员区渲染';
    const task = buildXiaoZhenTask(request);
    expect(task).toContain('小真');
    expect(task).toContain('较真');
    expect(task).toContain('证据');
    expect(task).toContain('不修复');
    expect(task).toContain('监督者');
    expect(task).toContain('验收标准');
    expect(task).toContain('缺陷清单');
    expect(task).toContain('PASS');
    expect(task).toContain('FAIL');
    expect(task).toContain('严重度');
    expect(task).toContain('【目标】');
    expect(task).toContain('【测试执行】');
    expect(task).toContain('【结论】');
    expect(task).toContain('【风险与建议】');
    expect(task).toContain(request);
  });
});

describe('createQaTool', () => {
  it('返回 qa.delegate 工具：L1 权限、task 必填', () => {
    const tool = createQaTool(makeRunner(async () => ({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 })));
    expect(tool.name).toBe('qa.delegate');
    expect(tool.permissionLevel).toBe(1);
    const schema = tool.inputSchema as { required?: string[] };
    expect(schema.required).toContain('task');
  });

  it('execute 缺 task 时返回 ok:false 且 error 含 task（不触达 dsh）', async () => {
    let called = false;
    const tool = createQaTool(
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

  it('execute task 为空字符串时同样校验失败', async () => {
    const tool = createQaTool(makeRunner(async () => ({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 })));
    const result = await tool.execute({ task: '   ' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
  });

  it('异步派单立即返回 taskId，并以 workspace-write 运行', async () => {
    let mode: string | undefined;
    const runner = makeRunner(async (_text, options) => {
      mode = options.permissionMode;
      return { stdout: '【目标】验收通过\n【结论】PASS', stderr: '', timedOut: false, exitCode: 0 };
    });
    const tool = createQaTool(runner);
    const result = await tool.execute({ task: '验收官网', directory: process.cwd() }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    const taskId = (result.data as { taskId: string }).taskId;
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
    await waitForStatus(runner, taskId);
    expect(mode).toBe('workspace-write');
    expect(runner.get(taskId)?.result).toContain('PASS');
  });
});
