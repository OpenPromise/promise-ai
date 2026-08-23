import { describe, expect, it, vi } from 'vitest';
import { buildXiaoZhiTask, createResearchTool } from './research-tools.js';
import { runDshHeadless } from './coding-tool.js';

// 只 mock runDshHeadless（派单不真跑 dsh），保留模块内真实常量。
vi.mock('./coding-tool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./coding-tool.js')>();
  return { ...actual, runDshHeadless: vi.fn() };
});

const runDshHeadlessMock = vi.mocked(runDshHeadless);

describe('buildXiaoZhiTask', () => {
  it('任务单包含小知人格关键词与研究工作流元素', () => {
    const request = '调研 MiniMax 视频接口 v1 到 v2 的迁移要点';
    const task = buildXiaoZhiTask(request);
    // 人格注入：小知 / 结论先行 / 来源 / 置信度
    expect(task).toContain('小知');
    expect(task).toContain('结论先行');
    expect(task).toContain('来源');
    expect(task).toContain('置信度');
    expect(task).toContain('监督者');
    // 工作流核心：交叉验证 / 知识沉淀 / AGENTS.md 纪律
    expect(task).toContain('交叉验证');
    expect(task).toContain('xiaozhi');
    expect(task).toContain('AGENTS.md');
    // 结构化简报元素（研究版）
    expect(task).toContain('【问题】');
    expect(task).toContain('【结论】');
    expect(task).toContain('【证据与来源】');
    expect(task).toContain('【未验证假设】');
    expect(task).toContain('【沉淀位置】');
    // 需求原文原样出现在任务单里
    expect(task).toContain(request);
  });
});

describe('createResearchTool', () => {
  it('返回 research.delegate 工具：L1 权限、task 必填', () => {
    const tool = createResearchTool();
    expect(tool.name).toBe('research.delegate');
    expect(tool.permissionLevel).toBe(1);
    const schema = tool.inputSchema as { required?: string[] };
    expect(schema.required).toContain('task');
  });

  it('execute 缺 task 时返回 ok:false 且 error 含 task（不触达 dsh）', async () => {
    const tool = createResearchTool();
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('task');
    expect(runDshHeadlessMock).not.toHaveBeenCalled();
  });

  it('dsh 成功时返回简报文本且以 workspace-write 运行', async () => {
    runDshHeadlessMock.mockResolvedValueOnce({
      stdout: '【问题】…\n【结论】v2 使用多模态 content 数组',
      stderr: '',
      timedOut: false,
      exitCode: 0,
    });
    const tool = createResearchTool();
    const result = await tool.execute({ task: '调研接口', directory: '/tmp' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect((result.data as { text: string }).text).toContain('content 数组');
    const [, options] = runDshHeadlessMock.mock.calls[0]!;
    expect(options.permissionMode).toBe('workspace-write');
  });
});
