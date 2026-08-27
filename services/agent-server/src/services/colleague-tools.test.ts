import { describe, expect, it } from 'vitest';
import { ColleagueTaskRunner, type ColleagueTask } from './colleague-task-runner.js';
import {
  createColleagueDelegateTool,
  createColleagueStatusTool,
  createMailAskTool,
  createMailSendTool,
  type ColleagueMailboxGateway,
} from './colleague-tools.js';
import { parseColleagueId } from './colleague-office.js';

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


describe('parseColleagueId / mail tools', () => {
  it('解析 小真 与 xiaozhen 为同一人', () => {
    expect(parseColleagueId('小真')).toBe('xiaozhen');
    expect(parseColleagueId('xiaozhen')).toBe('xiaozhen');
    expect(parseColleagueId(' 小美 ')).toBe('xiaomei');
    expect(parseColleagueId('小夜')).toBeUndefined();
  });

  it('mail.ask 把 小真/xiaozhen 都交给 office.ask，from 来自同事 session 不是 hub', async () => {
    const captured: Array<{ to: string; question: string; from: string }> = [];
    const record: ColleagueTask = {
      id: '33333333-3333-4333-8333-333333333333',
      colleague: '小真',
      task: '收一点',
      directory: '/app',
      status: 'success',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      output: '',
      result: '可以再收一点',
    };
    const office: ColleagueMailboxGateway = {
      delegate: async () => record,
      recentMail: () => [],
      colleagueIdForSession: (sessionId) => (sessionId === 'sess-xiaomei' ? 'xiaomei' : undefined),
      ask: async (to, question, options) => {
        captured.push({ to, question, from: options.from });
        return record;
      },
    };
    const tool = createMailAskTool(office);
    const byName = await tool.execute(
      { to: '小真', question: '视觉能不能再收一点' },
      { sessionId: 'sess-xiaomei' },
    );
    expect(byName.ok).toBe(true);
    expect(byName.data).toBe('可以再收一点');
    const byId = await tool.execute(
      { to: 'xiaozhen', question: '再问一次' },
      { sessionId: 'sess-xiaomei' },
    );
    expect(byId.ok).toBe(true);
    expect(captured).toEqual([
      { to: 'xiaozhen', question: '视觉能不能再收一点', from: 'xiaomei' },
      { to: 'xiaozhen', question: '再问一次', from: 'xiaomei' },
    ]);

    const asXiaoye = await tool.execute(
      { to: '小真', question: 'hub 不是同事' },
      { sessionId: 'weixin-hub-1' },
    );
    expect(asXiaoye.ok).toBe(false);
    expect(asXiaoye.error).toMatch(/仅供同事/);
  });

  it('mail.send 返回 taskId；to=小黑', async () => {
    const captured: Array<{ from: string; to: string; body: string }> = [];
    const record: ColleagueTask = {
      id: '44444444-4444-4444-8444-444444444444',
      colleague: '小黑',
      task: '实现',
      directory: '/app',
      status: 'running',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      output: '',
    };
    const office: ColleagueMailboxGateway = {
      delegate: async () => record,
      recentMail: () => [],
      colleagueIdForSession: (sessionId) => (sessionId === 'sess-xiaomei' ? 'xiaomei' : undefined),
      sendFrom: async (from, to, body) => {
        captured.push({ from, to, body });
        return record;
      },
    };
    const tool = createMailSendTool(office);
    const result = await tool.execute(
      { to: '小黑', body: '按 spec 实现' },
      { sessionId: 'sess-xiaomei' },
    );
    expect(result.ok).toBe(true);
    expect((result.data as { taskId: string }).taskId).toBe(record.id);
    expect(captured).toEqual([{ from: 'xiaomei', to: 'xiaohei', body: '按 spec 实现' }]);
  });
});
