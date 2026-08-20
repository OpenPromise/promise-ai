import { describe, expect, it } from 'vitest';
import { buildXiaoHeiTask, createEngineerTool } from './engineer-tools.js';

describe('buildXiaoHeiTask', () => {
  it('任务单包含小黑人格关键词与用户需求原文', () => {
    const request = '修复登录页 token 过期后跳转错误的 bug';
    const task = buildXiaoHeiTask(request);
    // 人格注入：小黑 / 专业 / 质量门 / 结构化报告
    expect(task).toContain('小黑');
    expect(task).toContain('专业');
    expect(task).toContain('typecheck');
    expect(task).toContain('结构化报告');
    // 需求原文原样出现在任务单里
    expect(task).toContain(request);
    // 监督者语境
    expect(task).toContain('监督者');
  });
});

describe('createEngineerTool', () => {
  it('返回 engineer.delegate 工具：L1 权限、task 必填', () => {
    const tool = createEngineerTool();
    expect(tool.name).toBe('engineer.delegate');
    expect(tool.permissionLevel).toBe(1);
    const schema = tool.inputSchema as { required?: string[] };
    expect(schema.required).toContain('task');
  });

  it('execute 缺 task 时返回 ok:false 且 error 含 task（不触达 dsh）', async () => {
    const tool = createEngineerTool();
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('task');
  });

  it('execute task 为空字符串时同样校验失败', async () => {
    const tool = createEngineerTool();
    const result = await tool.execute({ task: '   ' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('task');
  });

  it('directory 不存在时返回可读错误（不触达 dsh）', async () => {
    const tool = createEngineerTool();
    const result = await tool.execute(
      { task: '任意任务', directory: '/nonexistent-dir-for-engineer-tool-test' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('目录不存在');
  });
});
