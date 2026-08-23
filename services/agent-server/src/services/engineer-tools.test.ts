import { describe, expect, it } from 'vitest';
import { EngineerTaskRunner } from './engineer-task-runner.js';
import {
  buildXiaoHeiTask,
  createEngineerStatusTool,
  createEngineerTool,
} from './engineer-tools.js';

describe('buildXiaoHeiTask', () => {
  it('任务单包含小黑人格关键词与用户需求原文', () => {
    const request = '修复登录页 token 过期后跳转错误的 bug';
    const task = buildXiaoHeiTask(request);
    // 人格注入：小黑 / 专业 / 质量门 / 结构化报告
    expect(task).toContain('小黑');
    expect(task).toContain('专业');
    expect(task).toContain('typecheck');
    expect(task).toContain('结构化报告');
    // 自我进化落地：质量门前移 / 错误自愈 / Plan-Act 分离
    expect(task).toContain('质量门前移');
    expect(task).toContain('自愈');
    expect(task).toContain('Plan/Act 分离');
    // 自我进化 #2（grok-build）：规划期只读硬约束 / 安全边界 deny 优先 / 跨任务记忆沉淀
    expect(task).toContain('规划期只读');
    expect(task).toContain('永久/不可恢复');
    expect(task).toContain('learnings.md');
    // 自我进化 #3（Claude Code）：澄清先行 / 高信号优先 / 结论分级
    expect(task).toContain('待澄清问题');
    expect(task).toContain('高信号');
    expect(task).toContain('疑似/推断');
    // 自我进化 #4（ECC）：评审四问门禁 / 零发现有效 / 学习沉淀置信度 / 记忆信任边界
    expect(task).toContain('四问门禁');
    expect(task).toContain('零发现');
    expect(task).toContain('置信度');
    expect(task).toContain('未审查上下文');
    // 自我进化 #5（Leon）：任务模板化（按任务类型组织 输入→步骤→验证→产出）
    expect(task).toContain('任务模板');
    expect(task).toContain('待补项');
    // 需求原文原样出现在任务单里
    expect(task).toContain(request);
    // 监督者语境
    expect(task).toContain('监督者');
  });
});

describe('createEngineerTool', () => {
  function makeRunner() {
    return new EngineerTaskRunner({
      runTask: async () => ({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 }),
    });
  }

  it('返回 engineer.delegate 工具：L1 权限、task 必填', () => {
    const tool = createEngineerTool(makeRunner());
    expect(tool.name).toBe('engineer.delegate');
    expect(tool.permissionLevel).toBe(1);
    const schema = tool.inputSchema as { required?: string[] };
    expect(schema.required).toContain('task');
  });

  it('execute 缺 task 时返回 ok:false 且 error 含 task（不触达 dsh）', async () => {
    const tool = createEngineerTool(makeRunner());
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('task');
  });

  it('execute task 为空字符串时同样校验失败', async () => {
    const tool = createEngineerTool(makeRunner());
    const result = await tool.execute({ task: '   ' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('task');
  });

  it('directory 不存在时返回可读错误（不触达 dsh）', async () => {
    const tool = createEngineerTool(makeRunner());
    const result = await tool.execute(
      { task: '任意任务', directory: '/nonexistent-dir-for-engineer-tool-test' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('目录不存在');
  });

  it('有效任务立即返回 taskId（异步派单，不等执行结果）', async () => {
    let started = false;
    const runner = new EngineerTaskRunner({
      runTask: async (_taskText, { onData }) => {
        started = true;
        onData?.('开始干活\n', 'stdout');
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { stdout: '完成', stderr: '', timedOut: false, exitCode: 0 };
      },
    });
    const tool = createEngineerTool(runner);
    const result = await tool.execute(
      { task: '修复 bug', directory: process.cwd() },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    const data = result.data as { taskId: string; status: string };
    expect(data.status).toBe('running');
    expect(data.taskId).toMatch(/^[0-9a-f-]{36}$/);
    // 后台还在跑，但工具早已返回
    expect(started).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(runner.get(data.taskId)?.status).toBe('success');
  });
});

describe('createEngineerStatusTool', () => {
  it('权限 L0；按 taskId 返回状态/结果；无 taskId 返回最近任务列表', async () => {
    const runner = new EngineerTaskRunner({
      runTask: async () => ({ stdout: '报告：全部通过', stderr: '', timedOut: false, exitCode: 0 }),
    });
    const tool = createEngineerStatusTool(runner);
    expect(tool.name).toBe('engineer.status');
    expect(tool.permissionLevel).toBe(0);

    const task = await runner.delegate('跑测试', { directory: '/app' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const byId = await tool.execute({ taskId: task.id }, { sessionId: 's1' });
    const byIdData = byId.data as { status: string; result?: string };
    expect(byIdData.status).toBe('success');
    expect(byIdData.result).toContain('全部通过');

    const list = await tool.execute({}, { sessionId: 's1' });
    const listData = list.data as { count: number; tasks: Array<{ taskId: string }> };
    expect(listData.count).toBeGreaterThanOrEqual(1);
    expect(listData.tasks.some((t) => t.taskId === task.id)).toBe(true);

    const missing = await tool.execute({ taskId: 'does-not-exist' }, { sessionId: 's1' });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('找不到任务');
  });
});
