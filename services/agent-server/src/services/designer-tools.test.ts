import { describe, expect, it, vi } from 'vitest';
import { buildXiaoMeiTask, createDesignerTool } from './designer-tools.js';
import { DSH_NOT_FOUND_MESSAGE, runDshHeadless } from './coding-tool.js';

// 只 mock runDshHeadless（派单不真跑 dsh），保留模块内真实常量（DSH_NOT_FOUND_MESSAGE 等）。
vi.mock('./coding-tool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./coding-tool.js')>();
  return { ...actual, runDshHeadless: vi.fn() };
});

const runDshHeadlessMock = vi.mocked(runDshHeadless);

describe('buildXiaoMeiTask', () => {
  it('任务单包含小美人格关键词与 DESIGN_SPEC 契约元素', () => {
    const request = '给登录页做一版新的 UI 设计，重点优化注册转化';
    const task = buildXiaoMeiTask(request);
    // 人格注入：小美 / 设计 / UX / 不炫技
    expect(task).toContain('小美');
    expect(task).toContain('设计');
    expect(task).toContain('UX');
    expect(task).toContain('不炫技');
    expect(task).toContain('用户任务优先');
    // 工作流核心：DESIGN_SPEC（给小黑开发的机器可读契约）
    expect(task).toContain('DESIGN_SPEC');
    expect(task).toContain('Visual QA');
    // 工作准则要点
    expect(task).toContain('UX 先行');
    expect(task).toContain('Design System');
    expect(task).toContain('小黑');
    expect(task).toContain('权限边界');
    expect(task).toContain('监督者');
    // 结构化报告元素（设计师版）
    expect(task).toContain('【目标】');
    expect(task).toContain('【UX 分析】');
    expect(task).toContain('【视觉方向】');
    expect(task).toContain('【风险与建议】');
    // 需求原文原样出现在任务单里
    expect(task).toContain(request);
  });
});

describe('createDesignerTool', () => {
  it('返回 designer.delegate 工具：L1 权限、task 必填', () => {
    const tool = createDesignerTool();
    expect(tool.name).toBe('designer.delegate');
    expect(tool.permissionLevel).toBe(1);
    const schema = tool.inputSchema as { required?: string[] };
    expect(schema.required).toContain('task');
  });

  it('execute 缺 task 时返回 ok:false 且 error 含 task（不触达 dsh）', async () => {
    const tool = createDesignerTool();
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('task');
  });

  it('execute task 为空字符串时同样校验失败', async () => {
    const tool = createDesignerTool();
    const result = await tool.execute({ task: '   ' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('task');
  });

  it('directory 不存在时返回可读错误（不触达 dsh）', async () => {
    const tool = createDesignerTool();
    const result = await tool.execute(
      { task: '设计一个设置页', directory: '/nonexistent-dir-for-designer-tool-test' },
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
    const tool = createDesignerTool();
    const result = await tool.execute({ task: '梳理首页信息架构' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未找到 dsh');
    expect(result.error).toContain('@deepseek-ai/dsh');
  });

  it('执行成功时返回小美报告文本（workspace-write 权限驱动 dsh）', async () => {
    runDshHeadlessMock.mockResolvedValue({
      stdout: '【UX 分析】目标用户是新注册用户……\n【DESIGN_SPEC】--color-primary: #50e5fb',
      stderr: '',
      timedOut: false,
      exitCode: 0,
    });
    const tool = createDesignerTool();
    const result = await tool.execute({ task: '设计注册页', directory: '/app' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    const data = result.data as { text: string; backend: string; provider?: string; model?: string };
    expect(data.text).toContain('【DESIGN_SPEC】');
    expect(data.backend).toBe('dsh');
    // 小美以工作区权限运行，不做系统级操作
    expect(runDshHeadlessMock).toHaveBeenCalledWith(
      expect.stringContaining('小美'),
      expect.objectContaining({
        permissionMode: 'workspace-write',
      }),
    );
  });

  it('执行超时返回可读错误', async () => {
    runDshHeadlessMock.mockResolvedValue({
      stdout: '',
      stderr: '',
      timedOut: true,
      exitCode: 124,
    });
    const tool = createDesignerTool();
    const result = await tool.execute({ task: '设计首页', directory: '/app' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('被终止');
  });
});
