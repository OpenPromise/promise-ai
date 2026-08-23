import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildXiaoYouTask, createOpsTool } from './ops-tools.js';
import { DSH_NOT_FOUND_MESSAGE, runDshHeadless } from './coding-tool.js';
import { appendOpsAudit, type OpsAuditEntry } from './ops-audit.js';

// 只 mock runDshHeadless（派单不真跑 dsh），保留模块内真实常量（DSH_NOT_FOUND_MESSAGE 等）。
vi.mock('./coding-tool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./coding-tool.js')>();
  return { ...actual, runDshHeadless: vi.fn() };
});

/** 审计条目捕获队列：ops-audit.js 整体 mock 后由测试断言写入内容（resolveGitHead 也 mock，避免真跑 git）。 */
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

const runDshHeadlessMock = vi.mocked(runDshHeadless);
const appendOpsAuditMock = vi.mocked(appendOpsAudit);

// 审计断言依赖"本次派单"的调用计数与条目：每个测试前清空，避免跨测试累积。
beforeEach(() => {
  auditEntries.length = 0;
  appendOpsAuditMock.mockClear();
});

describe('buildXiaoYouTask', () => {
  it('任务单包含小优人格关键词与结构化报告元素', () => {
    const request = '服务器磁盘快满了，帮我清理一下并看看哪里占用最多';
    const task = buildXiaoYouTask(request);
    // 人格注入：小优 / 调皮可爱 / 运维工程师
    expect(task).toContain('小优');
    expect(task).toContain('调皮');
    expect(task).toContain('运维');
    expect(task).toContain('皮归皮');
    // 结构化报告元素（ops 版：操作清单 + 小优手记）
    expect(task).toContain('【目标】');
    expect(task).toContain('【操作清单】');
    expect(task).toContain('【验证结果】');
    expect(task).toContain('【风险与建议】');
    expect(task).toContain('小优手记');
    // 工作准则要点
    expect(task).toContain('永久/不可恢复');
    expect(task).toContain('回滚点');
    expect(task).toContain('Plan/Act 分离');
    expect(task).toContain('小夜姐');
    expect(task).toContain('监督者');
    // 自我进化（Leon）：前置条件自检（依赖/配置缺失先报告，不盲试）
    expect(task).toContain('前置条件');
    expect(task).toContain('缺失项');
    // 需求原文原样出现在任务单里
    expect(task).toContain(request);
  });
});

describe('createOpsTool', () => {
  it('返回 ops.delegate 工具：L1 权限、task 必填', () => {
    const tool = createOpsTool();
    expect(tool.name).toBe('ops.delegate');
    expect(tool.permissionLevel).toBe(1);
    const schema = tool.inputSchema as { required?: string[] };
    expect(schema.required).toContain('task');
  });

  it('execute 缺 task 时返回 ok:false 且 error 含 task（不触达 dsh）', async () => {
    const tool = createOpsTool();
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('task');
  });

  it('execute task 为空字符串时同样校验失败', async () => {
    const tool = createOpsTool();
    const result = await tool.execute({ task: '   ' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('task');
  });

  it('directory 不存在时返回可读错误（不触达 dsh）', async () => {
    const tool = createOpsTool();
    const result = await tool.execute(
      { task: '巡检服务器', directory: '/nonexistent-dir-for-ops-tool-test' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('目录不存在');
  });

  it('dsh 未安装时错误信息给出"缺什么/去哪补/怎么补"指引（不盲试）', async () => {
    runDshHeadlessMock.mockResolvedValue({
      stdout: '',
      stderr: DSH_NOT_FOUND_MESSAGE,
      timedOut: false,
      exitCode: 1,
    });
    const tool = createOpsTool();
    const result = await tool.execute({ task: '查看服务器时间' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未找到 dsh');
    expect(result.error).toContain('缺什么');
    expect(result.error).toContain('配置位置');
    expect(result.error).toContain('如何补');
    expect(result.error).toContain('@deepseek-ai/dsh');
  });
});

describe('ops.delegate 派单审计（Leon ToolCallLogger 留痕）', () => {
  it('派单成功时写入审计条目：taskId/任务摘要/目录/退出码/结果摘要/破坏性标记/git 基线', async () => {
    auditEntries.length = 0;
    runDshHeadlessMock.mockResolvedValue({
      stdout: '服务器时间：2026-08-23 12:00:00',
      stderr: '',
      timedOut: false,
      exitCode: 0,
    });
    const tool = createOpsTool();
    const result = await tool.execute(
      { task: '查看服务器时间', directory: '/app' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    expect(appendOpsAuditMock).toHaveBeenCalledTimes(1);
    const entry = auditEntries[0] as OpsAuditEntry;
    expect(entry.type).toBe('ops.delegate');
    expect(entry.taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.taskSummary).toContain('查看服务器时间');
    expect(entry.directory).toBe('/app');
    expect(entry.exitCode).toBe(0);
    expect(entry.timedOut).toBe(false);
    expect(entry.resultSummary).toContain('服务器时间');
    expect(entry.destructive).toBe(false);
    expect(entry.gitHead).toBe('test-git-head');
  });

  it('任务文本含破坏性关键词（删除/清空等）时 destructive=true', async () => {
    auditEntries.length = 0;
    runDshHeadlessMock.mockResolvedValue({
      stdout: '完成',
      stderr: '',
      timedOut: false,
      exitCode: 0,
    });
    const tool = createOpsTool();
    await tool.execute({ task: '删除 /tmp/old-logs 并清空缓存目录' }, { sessionId: 's1' });
    const entry = auditEntries[0] as OpsAuditEntry;
    expect(entry.destructive).toBe(true);
  });

  it('执行失败（exit≠0）时审计记录退出码与结果摘要', async () => {
    auditEntries.length = 0;
    runDshHeadlessMock.mockResolvedValue({
      stdout: '',
      stderr: '找不到命令',
      timedOut: false,
      exitCode: 127,
    });
    const tool = createOpsTool();
    const result = await tool.execute({ task: '跑一个不存在的命令' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    const entry = auditEntries[0] as OpsAuditEntry;
    expect(entry.exitCode).toBe(127);
    expect(entry.resultSummary).toContain('找不到命令');
  });

  it('派单启动失败（runDshHeadless 抛异常）也留痕：exitCode=null，错误信息可读', async () => {
    auditEntries.length = 0;
    runDshHeadlessMock.mockRejectedValue(new Error('spawn node ENOENT'));
    const tool = createOpsTool();
    const result = await tool.execute({ task: '查看服务器时间' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('小优派单启动失败');
    const entry = auditEntries[0] as OpsAuditEntry;
    expect(entry.exitCode).toBeNull();
    expect(entry.resultSummary).toContain('spawn node ENOENT');
  });

  it('校验失败（缺 task/目录不存在）不产生审计条目（未真正派单）', async () => {
    auditEntries.length = 0;
    const tool = createOpsTool();
    await tool.execute({}, { sessionId: 's1' });
    await tool.execute({ task: '巡检服务器', directory: '/nonexistent-xyz' }, { sessionId: 's1' });
    expect(appendOpsAuditMock).not.toHaveBeenCalled();
  });
});
