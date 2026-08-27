import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildXiaoYouTask,
  createOpsStatusTool,
  createOpsTaskRunner,
  createOpsTool,
} from './ops-tools.js';
import { DSH_NOT_FOUND_MESSAGE } from './coding-tool.js';
import type { OpsAuditEntry } from './ops-audit.js';
import { appendOpsAudit } from './ops-audit.js';
import type { RunTaskFn } from './colleague-task-runner.js';

const { auditEntries } = vi.hoisted(() => ({ auditEntries: [] as unknown[] }));
vi.mock('./ops-audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ops-audit.js')>();
  return {
    ...actual,
    appendOpsAudit: vi.fn(async (entry: unknown) => {
      auditEntries.push(entry);
    }),
    resolveGitHead: vi.fn(async () => 'test-git-head'),
  };
});

const appendOpsAuditMock = vi.mocked(appendOpsAudit);

beforeEach(() => {
  auditEntries.length = 0;
  appendOpsAuditMock.mockClear();
});

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
  return createOpsTaskRunner({ runTask, progressIntervalMs: 0 });
}

describe('buildXiaoYouTask', () => {
  it('任务单包含小优人格关键词与结构化报告元素', () => {
    const request = '服务器磁盘快满了，帮我清理一下并看看哪里占用最多';
    const task = buildXiaoYouTask(request);
    expect(task).toContain('小优');
    expect(task).toContain('调皮');
    expect(task).toContain('运维');
    expect(task).toContain('皮归皮');
    expect(task).toContain('【目标】');
    expect(task).toContain('【操作清单】');
    expect(task).toContain('【验证结果】');
    expect(task).toContain('【风险与建议】');
    expect(task).toContain('小优手记');
    expect(task).toContain('永久/不可恢复');
    expect(task).toContain('回滚点');
    expect(task).toContain('Plan/Act 分离');
    expect(task).toContain('小夜姐');
    expect(task).toContain('监督者');
    expect(task).toContain('前置条件');
    expect(task).toContain('缺失项');
    expect(task).toContain(request);
  });
});

describe('createOpsTool', () => {
  it('返回 ops.delegate 工具：L1 权限、task 必填', () => {
    const tool = createOpsTool(makeRunner(async () => ({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 })));
    expect(tool.name).toBe('ops.delegate');
    expect(tool.permissionLevel).toBe(1);
    const schema = tool.inputSchema as { required?: string[] };
    expect(schema.required).toContain('task');
  });

  it('execute 缺 task 时返回 ok:false 且 error 含 task（不触达 dsh）', async () => {
    const tool = createOpsTool(makeRunner(async () => ({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 })));
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('task');
  });

  it('execute task 为空字符串时同样校验失败', async () => {
    const tool = createOpsTool(makeRunner(async () => ({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 })));
    const result = await tool.execute({ task: '   ' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('task');
  });

  it('directory 不存在时返回可读错误（不触达 dsh）', async () => {
    const tool = createOpsTool(makeRunner(async () => ({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 })));
    const result = await tool.execute(
      { task: '巡检服务器', directory: '/nonexistent-dir-for-ops-tool-test' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('目录不存在');
  });

  it('有效任务立即返回 taskId（异步派单）；dsh 未安装时失败原因经 ops.status 可见', async () => {
    const runner = makeRunner(async () => ({
      stdout: '',
      stderr: DSH_NOT_FOUND_MESSAGE,
      timedOut: false,
      exitCode: 1,
    }));
    const tool = createOpsTool(runner);
    const result = await tool.execute(
      { task: '查看服务器时间', directory: process.cwd() },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    const data = result.data as { taskId: string; status: string };
    expect(data.taskId).toMatch(/^[0-9a-f-]{36}$/);
    // mock runTask 可能在 execute 返回前就 settle，不强制 status===running
    await waitForStatus(runner, data.taskId);
    const statusTool = createOpsStatusTool(runner);
    const status = await statusTool.execute({ taskId: data.taskId }, { sessionId: 's1' });
    expect(status.ok).toBe(true);
    const statusData = status.data as { status: string; error?: string };
    expect(statusData.status).toBe('failed');
    expect(statusData.error).toContain('未找到 dsh');
    expect(statusData.error).toContain('@deepseek-ai/dsh');
  });

  it('以 danger-full-access 驱动 dsh', async () => {
    let mode: string | undefined;
    const runner = makeRunner(async (_text, options) => {
      mode = options.permissionMode;
      return { stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 };
    });
    const tool = createOpsTool(runner);
    const result = await tool.execute(
      { task: '巡检', directory: process.cwd() },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    await waitForStatus(runner, (result.data as { taskId: string }).taskId);
    expect(mode).toBe('danger-full-access');
  });
});

describe('ops.delegate 派单审计（Leon ToolCallLogger 留痕）', () => {
  it('派单成功时写入审计条目：taskId/任务摘要/目录/退出码/结果摘要/破坏性标记/git 基线', async () => {
    const runner = makeRunner(async () => ({
      stdout: '服务器时间：2026-08-23 12:00:00',
      stderr: '',
      timedOut: false,
      exitCode: 0,
    }));
    const tool = createOpsTool(runner);
    const result = await tool.execute(
      { task: '查看服务器时间', directory: process.cwd() },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    const taskId = (result.data as { taskId: string }).taskId;
    await waitForStatus(runner, taskId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(appendOpsAuditMock).toHaveBeenCalledTimes(1);
    const entry = auditEntries[0] as OpsAuditEntry;
    expect(entry.type).toBe('ops.delegate');
    expect(entry.taskId).toBe(taskId);
    expect(entry.taskSummary).toContain('查看服务器时间');
    expect(entry.directory).toBe(path.resolve(process.cwd()));
    expect(entry.exitCode).toBe(0);
    expect(entry.timedOut).toBe(false);
    expect(entry.resultSummary).toContain('服务器时间');
    expect(entry.destructive).toBe(false);
    expect(entry.gitHead).toBe('test-git-head');
  });

  it('任务文本含破坏性关键词（删除/清空等）时 destructive=true', async () => {
    const runner = makeRunner(async () => ({
      stdout: '完成',
      stderr: '',
      timedOut: false,
      exitCode: 0,
    }));
    const tool = createOpsTool(runner);
    const result = await tool.execute(
      { task: '删除 /tmp/old-logs 并清空缓存目录', directory: process.cwd() },
      { sessionId: 's1' },
    );
    const taskId = (result.data as { taskId: string }).taskId;
    await waitForStatus(runner, taskId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const entry = auditEntries[0] as OpsAuditEntry;
    expect(entry.destructive).toBe(true);
  });

  it('执行失败（exit≠0）时审计记录退出码与结果摘要', async () => {
    const runner = makeRunner(async () => ({
      stdout: '',
      stderr: '找不到命令',
      timedOut: false,
      exitCode: 127,
    }));
    const tool = createOpsTool(runner);
    const result = await tool.execute(
      { task: '跑一个不存在的命令', directory: process.cwd() },
      { sessionId: 's1' },
    );
    const taskId = (result.data as { taskId: string }).taskId;
    expect(result.ok).toBe(true);
    await waitForStatus(runner, taskId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const entry = auditEntries[0] as OpsAuditEntry;
    expect(entry.exitCode).toBe(127);
    expect(entry.resultSummary).toContain('找不到命令');
  });

  it('派单启动失败（runTask 抛异常）也留痕：exitCode=null', async () => {
    const runner = makeRunner(async () => {
      throw new Error('spawn node ENOENT');
    });
    const tool = createOpsTool(runner);
    const result = await tool.execute(
      { task: '查看服务器时间', directory: process.cwd() },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    const taskId = (result.data as { taskId: string }).taskId;
    await waitForStatus(runner, taskId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runner.get(taskId)?.error).toContain('spawn node ENOENT');
    const entry = auditEntries[0] as OpsAuditEntry;
    expect(entry.exitCode).toBeNull();
    expect(entry.resultSummary).toContain('spawn node ENOENT');
  });

  it('校验失败（缺 task/目录不存在）不产生审计条目（未真正派单）', async () => {
    const runner = makeRunner(async () => ({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 }));
    const tool = createOpsTool(runner);
    await tool.execute({}, { sessionId: 's1' });
    await tool.execute({ task: '巡检服务器', directory: '/nonexistent-xyz' }, { sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(appendOpsAuditMock).not.toHaveBeenCalled();
  });
});
