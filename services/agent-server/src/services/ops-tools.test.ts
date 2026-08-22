import { describe, expect, it } from 'vitest';
import { buildXiaoYouTask, createOpsTool } from './ops-tools.js';

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
});
