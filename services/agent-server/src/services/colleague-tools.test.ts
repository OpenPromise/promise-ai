import { describe, expect, it } from 'vitest';
import { ColleagueTaskRunner, type ColleagueTask } from './colleague-task-runner.js';
import { createColleagueDelegateTool, createColleagueStatusTool, type ColleagueMailboxGateway } from './colleague-tools.js';

describe('createColleagueStatusTool', () => {
  it('taskId 在 runner 没有时回退 office.getTask（会话路径）', async () => {
    const runner = new ColleagueTaskRunner(
      {
        id: 'engineer',
        name: '小黑',
        permissionMode: 'workspace-write',
        buildTask: (task) => task,
        startedText: '小黑已开工',
      },
      {
        runTask: async () => ({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 }),
      },
    );
    const record: ColleagueTask = {
      id: '11111111-1111-4111-8111-111111111111',
      colleague: '小黑',
      task: '修 bug',
      directory: '/app',
      status: 'success',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      output: '',
      result: '【目标】修好了',
    };
    const office: ColleagueMailboxGateway = {
      delegate: async () => record,
      recentMail: () => [{ id: 'm1', subject: '修 bug', status: 'done', createdAt: record.createdAt }],
      getTask: (id) => (id === record.id ? record : undefined),
      listTasks: () => [record],
    };
    const tool = createColleagueStatusTool({
      name: 'engineer.status',
      displayName: '小黑',
      runner,
      colleagueId: 'xiaohei',
      office,
    });
    const byId = await tool.execute({ taskId: record.id }, { sessionId: 's1' });
    expect(byId.ok).toBe(true);
    const data = byId.data as { status: string; result?: string };
    expect(data.status).toBe('success');
    expect(data.result).toContain('修好了');

    const listed = await tool.execute({}, { sessionId: 's1' });
    const listData = listed.data as { count: number; tasks: Array<{ taskId: string }> };
    expect(listData.tasks.some((item) => item.taskId === record.id)).toBe(true);
  });
});

describe('createColleagueDelegateTool', () => {
  it('execute 把 ToolContext.sessionId 传给 office.delegate 作为 hubSessionId', async () => {
    const runner = new ColleagueTaskRunner(
      {
        id: 'research',
        name: '小知',
        permissionMode: 'workspace-write',
        buildTask: (task) => task,
        startedText: '小知已开工',
      },
      {
        runTask: async () => {
          throw new Error('不应走 runner');
        },
      },
    );
    const record: ColleagueTask = {
      id: '22222222-2222-4222-8222-222222222222',
      colleague: '小知',
      task: '调研竞品',
      directory: process.cwd(),
      status: 'running',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      output: '',
    };
    const captured: Array<{
      colleagueId: string;
      task: string;
      options?: { hubSessionId?: string };
    }> = [];
    const office: ColleagueMailboxGateway = {
      delegate: async (colleagueId, task, options) => {
        captured.push({ colleagueId, task, options });
        return record;
      },
      recentMail: () => [],
    };
    const tool = createColleagueDelegateTool({
      name: 'research.delegate',
      description: '给小知发任务',
      displayName: '小知',
      statusToolName: 'research.status',
      runner,
      colleagueId: 'xiaozhi',
      office,
    });
    const result = await tool.execute(
      { task: '调研三家竞品', directory: process.cwd() },
      { sessionId: 'weixin-hub-1' },
    );
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.colleagueId).toBe('xiaozhi');
    expect(captured[0]?.task).toBe('调研三家竞品');
    expect(captured[0]?.options?.hubSessionId).toBe('weixin-hub-1');
  });
});
