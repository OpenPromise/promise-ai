import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '@personal-ai/memory';
import {
  ColleagueTaskRunner,
  type ColleagueSpec,
  type ColleagueTaskEvent,
  type RunTaskFn,
} from './colleague-task-runner.js';
import { createColleagueStatusTool } from './colleague-tools.js';
import {
  BLOCKED_COLLEAGUE_TOOLS,
  COLLEAGUE_IDS,
  COLLEAGUE_ROSTER,
  ColleagueOffice,
  colleagueToolAllowlist,
  type ColleagueConversation,
  type ColleagueId,
  type ColleagueRunners,
} from './colleague-office.js';

function stubSpec(id: string, name: string): ColleagueSpec {
  return {
    id,
    name,
    permissionMode: 'workspace-write',
    buildTask: (task) => task,
    startedText: `${name}已开工`,
  };
}

function stubRunners(runTask?: RunTaskFn): ColleagueRunners {
  const run: RunTaskFn =
    runTask ??
    (async () => ({ stdout: '【目标】完成\n报告 ok', stderr: '', timedOut: false, exitCode: 0 }));
  const names: Record<ColleagueId, string> = {
    xiaohei: '小黑',
    xiaoyou: '小优',
    xiaomei: '小美',
    xiaozhen: '小真',
    xiaozhi: '小知',
  };
  const runners = {} as ColleagueRunners;
  for (const id of COLLEAGUE_IDS) {
    runners[id] = new ColleagueTaskRunner(stubSpec(id, names[id]), { runTask: run });
  }
  return runners;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timeout waiting for colleague office condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('ColleagueOffice', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeOffice(options: { store?: InMemorySessionStore; runTask?: RunTaskFn } = {}) {
    const mailboxDir = await mkdtemp(path.join(tmpdir(), 'mailboxes-'));
    dirs.push(mailboxDir);
    const store = options.store ?? new InMemorySessionStore();
    const runners = stubRunners(options.runTask);
    const office = new ColleagueOffice({ store, runners, mailboxDir });
    await office.ensureSessions();
    await office.hydrate();
    return { office, store, runners, mailboxDir };
  }

  it('ensureSessions 幂等：二次启动复用同一批 session id', async () => {
    const store = new InMemorySessionStore();
    const first = await makeOffice({ store });
    const ids1 = COLLEAGUE_IDS.map((id) => first.office.getSessionId(id));
    expect(new Set(ids1).size).toBe(5);
    expect(ids1.every((id) => typeof id === 'string')).toBe(true);

    const colleagues = (await store.listSessions()).filter((s) => s.metadata?.role === 'colleague');
    expect(colleagues).toHaveLength(5);
    for (const session of colleagues) {
      expect(session.metadata?.colleagueId).toBeTruthy();
      expect(session.systemPrompt.length).toBeGreaterThan(20);
    }

    const second = await makeOffice({ store });
    const ids2 = COLLEAGUE_IDS.map((id) => second.office.getSessionId(id));
    expect(ids2).toEqual(ids1);
    const after = (await store.listSessions()).filter((s) => s.metadata?.role === 'colleague');
    expect(after).toHaveLength(5);
  });

  it('ensureSessions 刷新空的 / 过期的 systemPrompt，不新建 session', async () => {
    const store = new InMemorySessionStore();
    const stale = await store.createSession({
      systemPrompt: '',
      metadata: { role: 'colleague', colleagueId: 'xiaohei', name: '小黑' },
    });
    const { office } = await makeOffice({ store });
    expect(office.getSessionId('xiaohei')).toBe(stale.id);
    const refreshed = await store.getSession(stale.id);
    expect(refreshed.systemPrompt).toContain('小黑');
    expect(refreshed.systemPrompt).toBe(COLLEAGUE_ROSTER[0]?.prompt);
  });

  it('ensureSessions 不改动微信 peer 会话', async () => {
    const store = new InMemorySessionStore();
    const weixin = await store.createSession({
      systemPrompt: '小夜',
      metadata: { channel: 'weixin', peerId: 'wxid_ceo' },
    });
    await makeOffice({ store });
    const still = await store.getSession(weixin.id);
    expect(still.systemPrompt).toBe('小夜');
    expect(still.metadata).toEqual({ channel: 'weixin', peerId: 'wxid_ceo' });
  });

  it('delegate 写信入收件箱并记入同事会话；完成后标记 done + assistant 回复', async () => {
    const { office, store, mailboxDir } = await makeOffice();
    const record = await office.delegate('xiaohei', '修登录跳转 bug');
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);

    const sessionId = office.getSessionId('xiaohei')!;
    let session = await store.getSession(sessionId);
    expect(session.messages[0]?.role).toBe('user');
    expect(session.messages[0]?.content).toBe('修登录跳转 bug');

    const queuedOrRunning = office.listMailbox('xiaohei');
    expect(queuedOrRunning).toHaveLength(1);
    expect(queuedOrRunning[0]?.from).toBe('xiaoye');
    expect(queuedOrRunning[0]?.to).toBe('xiaohei');
    expect(queuedOrRunning[0]?.taskId).toBe(record.id);

    await waitFor(() => office.listMailbox('xiaohei')[0]?.status === 'done');
    const done = office.listMailbox('xiaohei')[0];
    expect(done?.status).toBe('done');
    expect(done?.reply).toContain('完成');

    session = await store.getSession(sessionId);
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1]?.role).toBe('assistant');
    expect(session.messages[1]?.content).toContain('完成');

    const raw = await readFile(path.join(mailboxDir, 'xiaohei.json'), 'utf8');
    const fileMail = JSON.parse(raw) as Array<{ body: string; status: string }>;
    expect(fileMail).toHaveLength(1);
    expect(fileMail[0]?.body).toBe('修登录跳转 bug');
    expect(fileMail[0]?.status).toBe('done');
  });

  it('*.status 列出最近 3 封收件箱主题/状态', async () => {
    let release: (() => void) | undefined;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { office, runners } = await makeOffice({
      runTask: async () => {
        await block;
        return { stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 };
      },
    });
    await office.delegate('xiaohei', '第一封：改 API');
    await office.delegate('xiaohei', '第二封：补测试');
    const previews = office.recentMail('xiaohei', 3);
    expect(previews).toHaveLength(2);
    expect(previews[0]?.subject).toContain('第二封');
    expect(previews[0]?.status).toBe('running');
    expect(previews[1]?.subject).toContain('第一封');

    const statusTool = createColleagueStatusTool({
      name: 'engineer.status',
      displayName: '小黑',
      runner: runners.xiaohei,
      colleagueId: 'xiaohei',
      office,
    });
    const listed = await statusTool.execute({}, { sessionId: 's1' });
    expect(listed.ok).toBe(true);
    const data = listed.data as {
      mailbox: Array<{ subject: string; status: string }>;
    };
    expect(data.mailbox).toHaveLength(2);
    expect(data.mailbox.some((item) => item.subject.includes('第一封') && item.status === 'running')).toBe(
      true,
    );

    release?.();
    await waitFor(() => office.listMailbox('xiaohei').every((m) => m.status === 'done'));
  });

  it('失败任务把收件箱标 failed 并写入 assistant 错误', async () => {
    const { office, store } = await makeOffice({
      runTask: async () => ({ stdout: '', stderr: 'boom', timedOut: false, exitCode: 1 }),
    });
    await office.delegate('xiaoyou', '重启坏掉的服务');
    await waitFor(() => office.listMailbox('xiaoyou')[0]?.status === 'failed');
    const mail = office.listMailbox('xiaoyou')[0];
    expect(mail?.status).toBe('failed');
    expect(mail?.reply).toBeTruthy();
    const session = await store.getSession(office.getSessionId('xiaoyou')!);
    expect(session.messages[1]?.role).toBe('assistant');
  });

  it('allowlist 递归守卫：不含 *.delegate / 同事 *.status，保留 system.status', () => {
    for (const id of COLLEAGUE_IDS) {
      const list = colleagueToolAllowlist(id);
      expect(list.some((name) => name.endsWith('.delegate'))).toBe(false);
      for (const blocked of BLOCKED_COLLEAGUE_TOOLS) {
        expect(list).not.toContain(blocked);
      }
    }
    expect(colleagueToolAllowlist('xiaohei')).toEqual([
      'filesystem.search',
      'memory.list',
      'memory.remember',
      'coding.run',
      'github.search_repos',
      'github.issues',
      'github.create_issue',
      'github.comment',
      'server.shell',
    ]);
    expect(colleagueToolAllowlist('xiaoyou')).toContain('system.status');
    expect(colleagueToolAllowlist('xiaoyou')).toContain('server.shell');
    expect(colleagueToolAllowlist('xiaomei')).toContain('coding.run');
    expect(colleagueToolAllowlist('xiaozhen')).toEqual([
      'filesystem.search',
      'memory.list',
      'memory.remember',
      'coding.run',
      'server.shell',
    ]);
    expect(colleagueToolAllowlist('xiaozhi')).toEqual([
      'filesystem.search',
      'memory.list',
      'memory.remember',
      'web.search',
      'web.fetch',
      'github.search_repos',
      'time.get',
    ]);
  });

  it('conversation.runChat：立即返回 running；drain 后收件箱 done 且 allowlist 无 *.delegate', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const captured: Array<{
      userMessage: string;
      headless?: boolean;
      toolAllowlist?: string[];
      toolBudget?: number;
      sessionId: string;
    }> = [];
    const conversation: ColleagueConversation = {
      async *runChat(input) {
        captured.push(input);
        await gate;
        yield {
          type: 'agent.tool_call',
          payload: { toolCalls: [{ name: 'coding.run' }, { name: 'time.get' }] },
        };
        yield { type: 'chat.done', payload: { text: '【目标】修好了\n报告 ok' } };
      },
    };

    const { office, store, runners } = await makeOffice({
      runTask: async () => {
        throw new Error('conversation 路径不应调用 runner.delegate / dsh');
      },
    });
    const events: ColleagueTaskEvent[] = [];
    office.onEvent((event) => events.push(event));
    office.attachConversation(conversation);

    const record = await office.delegate('xiaohei', '修登录跳转 bug');
    expect(record.status).toBe('running');
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(office.listMailbox('xiaohei')[0]?.status).toBe('running');
    expect(office.listMailbox('xiaohei')[0]?.taskId).toBe(record.id);
    expect(events[0]).toMatchObject({
      type: 'started',
      colleague: '小黑',
      taskId: record.id,
    });

    const sessionId = office.getSessionId('xiaohei')!;
    const before = await store.getSession(sessionId);
    expect(before.messages).toHaveLength(0);

    await waitFor(() => captured.length === 1);
    expect(captured[0]?.sessionId).toBe(sessionId);
    expect(captured[0]?.userMessage).toBe('【小夜来信】\n修登录跳转 bug');
    expect(captured[0]?.headless).toBe(true);
    expect(captured[0]?.toolBudget).toBe(12);
    expect(captured[0]?.toolAllowlist).toEqual(colleagueToolAllowlist('xiaohei'));
    expect(captured[0]?.toolAllowlist?.some((name) => name.endsWith('.delegate'))).toBe(false);
    expect(captured[0]?.toolAllowlist).not.toContain('engineer.delegate');
    expect(captured[0]?.toolAllowlist).not.toContain('engineer.status');

    release();
    await waitFor(() => office.listMailbox('xiaohei')[0]?.status === 'done');
    const done = office.listMailbox('xiaohei')[0];
    expect(done?.reply).toContain('修好了');
    expect(office.getTask(record.id)?.status).toBe('success');
    expect(events.some((event) => event.type === 'progress' && event.text === '正在写代码')).toBe(
      true,
    );
    expect(
      events.some(
        (event) =>
          event.type === 'progress' &&
          (event.text === 'time.get' || (event.text ?? '').includes('time.get')),
      ),
    ).toBe(false);
    expect(events.some((event) => event.type === 'done' && event.status === 'success')).toBe(true);

    const after = await store.getSession(sessionId);
    expect(after.messages).toHaveLength(0);

    const statusTool = createColleagueStatusTool({
      name: 'engineer.status',
      displayName: '小黑',
      runner: runners.xiaohei,
      colleagueId: 'xiaohei',
      office,
    });
    const byId = await statusTool.execute({ taskId: record.id }, { sessionId: 's1' });
    expect(byId.ok).toBe(true);
    expect((byId.data as { status: string; result?: string }).status).toBe('success');
    expect((byId.data as { result?: string }).result).toContain('修好了');
  });

  it('进度只广播白名单内工具，并用人话而不是原始工具名', async () => {
    const conversation: ColleagueConversation = {
      async *runChat() {
        yield {
          type: 'agent.tool_call',
          payload: {
            toolCalls: [{ name: 'web.search' }, { name: 'time.get' }, { name: 'unknown.tool' }],
          },
        };
        yield { type: 'chat.done', payload: { text: '简报' } };
      },
    };
    const { office } = await makeOffice();
    const events: ColleagueTaskEvent[] = [];
    office.onEvent((event) => events.push(event));
    office.attachConversation(conversation);
    await office.delegate('xiaozhi', '调研');
    await waitFor(() => events.some((event) => event.type === 'done'));
    const progress = events.filter((event) => event.type === 'progress').map((event) => event.text);
    expect(progress).toContain('正在检索网页');
    expect(progress).toContain('正在看时间');
    expect(
      progress.some(
        (text) =>
          text === 'web.search' ||
          text === 'time.get' ||
          text === 'unknown.tool' ||
          (text ?? '').includes('unknown'),
      ),
    ).toBe(false);
  });

  it('conversation chat.error / throw 把收件箱标 failed', async () => {
    const errorConv: ColleagueConversation = {
      async *runChat() {
        yield { type: 'chat.error', payload: { error: 'llm down' } };
      },
    };
    const { office: errorOffice } = await makeOffice();
    errorOffice.attachConversation(errorConv);
    await errorOffice.delegate('xiaozhi', '查竞品');
    await waitFor(() => errorOffice.listMailbox('xiaozhi')[0]?.status === 'failed');
    expect(errorOffice.listMailbox('xiaozhi')[0]?.reply).toContain('llm down');

    const throwConv: ColleagueConversation = {
      async *runChat() {
        throw new Error('boom');
      },
    };
    const { office: throwOffice } = await makeOffice();
    throwOffice.attachConversation(throwConv);
    await throwOffice.delegate('xiaomei', '出视觉稿');
    await waitFor(() => throwOffice.listMailbox('xiaomei')[0]?.status === 'failed');
    expect(throwOffice.listMailbox('xiaomei')[0]?.reply).toContain('boom');
  });
});
