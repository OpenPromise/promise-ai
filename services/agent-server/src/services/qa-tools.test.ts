import { describe, expect, it, vi } from 'vitest';
import { buildXiaoZhenTask, createQaTool } from './qa-tools.js';
import { runDshHeadless } from './coding-tool.js';

// 只 mock runDshHeadless（派单不真跑 dsh），保留模块内真实常量。
vi.mock('./coding-tool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./coding-tool.js')>();
  return { ...actual, runDshHeadless: vi.fn() };
});

const runDshHeadlessMock = vi.mocked(runDshHeadless);

describe('buildXiaoZhenTask', () => {
  it('任务单包含小真人格关键词与验收工作流元素', () => {
    const request = '验收官网改版：构建、资源可访问性、成员区渲染';
    const task = buildXiaoZhenTask(request);
    // 人格注入：小真 / 较真 / 证据 / 独立验收
    expect(task).toContain('小真');
    expect(task).toContain('较真');
    expect(task).toContain('证据');
    expect(task).toContain('不修复');
    expect(task).toContain('监督者');
    // 工作流核心：验收标准 / 缺陷清单 / PASS-FAIL
    expect(task).toContain('验收标准');
    expect(task).toContain('缺陷清单');
    expect(task).toContain('PASS');
    expect(task).toContain('FAIL');
    expect(task).toContain('严重度');
    // 结构化报告元素（QA 版）
    expect(task).toContain('【目标】');
    expect(task).toContain('【测试执行】');
    expect(task).toContain('【结论】');
    expect(task).toContain('【风险与建议】');
    // 需求原文原样出现在任务单里
    expect(task).toContain(request);
  });
});

describe('createQaTool', () => {
  it('返回 qa.delegate 工具：L1 权限、task 必填', () => {
    const tool = createQaTool();
    expect(tool.name).toBe('qa.delegate');
    expect(tool.permissionLevel).toBe(1);
    const schema = tool.inputSchema as { required?: string[] };
    expect(schema.required).toContain('task');
  });

  it('execute 缺 task 时返回 ok:false 且 error 含 task（不触达 dsh）', async () => {
    const tool = createQaTool();
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('task');
    expect(runDshHeadlessMock).not.toHaveBeenCalled();
  });

  it('execute task 为空字符串时同样校验失败', async () => {
    const tool = createQaTool();
    const result = await tool.execute({ task: '   ' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
  });

  it('dsh 成功时返回报告文本且以 workspace-write 运行', async () => {
    runDshHeadlessMock.mockResolvedValueOnce({
      stdout: '【目标】验收通过\n【结论】PASS',
      stderr: '',
      timedOut: false,
      exitCode: 0,
    });
    const tool = createQaTool();
    const result = await tool.execute({ task: '验收官网', directory: '/tmp' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect((result.data as { text: string }).text).toContain('PASS');
    const [, options] = runDshHeadlessMock.mock.calls[0]!;
    expect(options.permissionMode).toBe('workspace-write');
  });
});
