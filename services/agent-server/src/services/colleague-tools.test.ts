import { describe, expect, it } from 'vitest';
import { ColleagueTaskRunner, type ColleagueTask } from './colleague-task-runner.js';
import { createColleagueStatusTool, type ColleagueMailboxGateway } from './colleague-tools.js';

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
