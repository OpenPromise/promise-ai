import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  wrapUpFallback,
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
    // 20s 窗口内第二条人话（正在看时间）被合并，不刷屏
    expect(progress.filter((text) => text === '正在检索网页' || text === '正在看时间')).toHaveLength(1);
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

  it('hubSessionId 写入收件箱；验收在 hub 会话 runChat；done.result 是验收文，mailbox.reply 是同事原文', async () => {
    const captured: Array<{
      sessionId: string;
      userMessage: string;
      headless?: boolean;
      toolAllowlist?: string[];
      toolBudget?: number;
    }> = [];
    const conversation: ColleagueConversation = {
      async *runChat(input) {
        captured.push(input);
        if (input.userMessage.startsWith('【同事回信】')) {
          yield {
            type: 'agent.tool_call',
            payload: { toolCalls: [{ name: 'memory.list' }] },
          };
          yield {
            type: 'chat.done',
            payload: { text: '小知把竞品表交来了，要点清楚。要再派跟我说。' },
          };
          return;
        }
        yield { type: 'chat.done', payload: { text: '【目标】调研完成\n报告 ok' } };
      },
    };
    const { office, mailboxDir } = await makeOffice({
      runTask: async () => {
        throw new Error('conversation 路径不应调用 runner');
      },
    });
    const events: ColleagueTaskEvent[] = [];
    office.onEvent((event) => events.push(event));
    office.attachConversation(conversation);

    const hubSessionId = 'weixin-hub-session';
    const record = await office.delegate('xiaozhi', '调研三家竞品', { hubSessionId });
    expect(office.listMailbox('xiaozhi')[0]?.hubSessionId).toBe(hubSessionId);
    expect(office.getTask(record.id)?.hubSessionId).toBe(hubSessionId);
    expect(office.getSessionId('xiaozhi')).not.toBe(hubSessionId);

    await waitFor(() => events.filter((event) => event.type === 'done').length === 1, 1000);
    expect(captured).toHaveLength(2);
    expect(captured[0]?.sessionId).toBe(office.getSessionId('xiaozhi'));
    expect(captured[1]?.sessionId).toBe(hubSessionId);
    expect(captured[1]?.userMessage).toContain('【同事回信】');
    expect(captured[1]?.userMessage).toContain('小知');
    expect(captured[1]?.userMessage).toContain(record.id.slice(0, 8));
    expect(captured[1]?.headless).toBe(true);
    expect(captured[1]?.toolBudget).toBe(2);
    expect(captured[1]?.toolAllowlist).toEqual(['memory.list', 'memory.remember']);
    expect(captured[1]?.toolAllowlist?.some((name) => name.endsWith('.delegate'))).toBe(false);
    expect(captured[1]?.toolAllowlist).not.toContain('research.status');

    const mail = office.listMailbox('xiaozhi')[0];
    expect(mail?.status).toBe('done');
    expect(mail?.reply).toContain('调研完成');
    expect(mail?.reply).not.toContain('要点清楚');
    const done = events.find((event) => event.type === 'done');
    expect(done?.result).toBe('小知把竞品表交来了，要点清楚。要再派跟我说。');
    expect(done?.result).not.toContain('【目标】');
    expect(office.getTask(record.id)?.result).toContain('调研完成');
    // 验收过程的 memory.list 不冒同事进度
    expect(events.some((event) => event.type === 'progress' && event.text === '正在查阅记忆')).toBe(
      false,
    );

    const raw = await readFile(path.join(mailboxDir, 'xiaozhi.json'), 'utf8');
    const fileMail = JSON.parse(raw) as Array<{ hubSessionId?: string; reply?: string }>;
    expect(fileMail[0]?.hubSessionId).toBe(hubSessionId);
    expect(fileMail[0]?.reply).toContain('调研完成');
  });

  it('同事会话 id 不能当 hub；无 hubSessionId 时 done 用小夜口吻回退', async () => {
    const captured: string[] = [];
    const conversation: ColleagueConversation = {
      async *runChat(input) {
        captured.push(input.sessionId);
        yield { type: 'chat.done', payload: { text: '同事简报' } };
      },
    };
    const { office } = await makeOffice();
    const events: ColleagueTaskEvent[] = [];
    office.onEvent((event) => events.push(event));
    office.attachConversation(conversation);

    const colleagueSession = office.getSessionId('xiaozhi')!;
    await office.delegate('xiaozhi', '查资料', { hubSessionId: colleagueSession });
    await waitFor(() => events.some((event) => event.type === 'done'), 1000);
    expect(office.listMailbox('xiaozhi')[0]?.hubSessionId).toBeUndefined();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe(colleagueSession);
    const done = events.find((event) => event.type === 'done');
    expect(done?.result).toBe(wrapUpFallback('小知', done!.taskId.slice(0, 8), true, '同事简报'));
    expect(office.listMailbox('xiaozhi')[0]?.reply).toBe('同事简报');
  });

  it('验收 runChat 失败/空文本回退小夜口吻；hub 忙则跳过 LLM', async () => {
    const { office: failOffice } = await makeOffice();
    const failEvents: ColleagueTaskEvent[] = [];
    failOffice.onEvent((event) => failEvents.push(event));
    failOffice.attachConversation({
      async *runChat(input) {
        if (input.userMessage.startsWith('【同事回信】')) {
          throw new Error('hub llm down');
        }
        yield { type: 'chat.done', payload: { text: '简报正文' } };
      },
    });
    await failOffice.delegate('xiaomei', '出视觉稿', { hubSessionId: 'hub-fail' });
    await waitFor(() => failEvents.some((event) => event.type === 'done'), 1000);
    const failDone = failEvents.find((event) => event.type === 'done');
    expect(failDone?.result).toBe(
      wrapUpFallback('小美', failDone!.taskId.slice(0, 8), true, '简报正文'),
    );
    expect(failOffice.listMailbox('xiaomei')[0]?.reply).toBe('简报正文');

    const { office: emptyOffice } = await makeOffice();
    const emptyEvents: ColleagueTaskEvent[] = [];
    emptyOffice.onEvent((event) => emptyEvents.push(event));
    emptyOffice.attachConversation({
      async *runChat(input) {
        if (input.userMessage.startsWith('【同事回信】')) {
          yield { type: 'chat.done', payload: { text: '   ' } };
          return;
        }
        yield { type: 'chat.done', payload: { text: '空验收上游简报' } };
      },
    });
    await emptyOffice.delegate('xiaozhen', '回归', { hubSessionId: 'hub-empty' });
    await waitFor(() => emptyEvents.some((event) => event.type === 'done'), 1000);
    const emptyDone = emptyEvents.find((event) => event.type === 'done');
    expect(emptyDone?.result).toBe(
      wrapUpFallback('小真', emptyDone!.taskId.slice(0, 8), true, '空验收上游简报'),
    );

    let hubCalls = 0;
    const { office: busyOffice } = await makeOffice();
    const busyEvents: ColleagueTaskEvent[] = [];
    busyOffice.onEvent((event) => busyEvents.push(event));
    busyOffice.attachConversation({
      isSessionBusy: (sessionId) => sessionId === 'hub-busy',
      async *runChat(input) {
        if (input.userMessage.startsWith('【同事回信】')) hubCalls += 1;
        yield { type: 'chat.done', payload: { text: '同事回信原文' } };
      },
    });
    await busyOffice.delegate('xiaohei', '修 bug', { hubSessionId: 'hub-busy' });
    await waitFor(() => busyEvents.some((event) => event.type === 'done'), 1000);
    expect(hubCalls).toBe(0);
    const busyDone = busyEvents.find((event) => event.type === 'done');
    expect(busyDone?.result).toBe(
      wrapUpFallback('小黑', busyDone!.taskId.slice(0, 8), true, '同事回信原文'),
    );
  });

  it('进度 debounce：同一任务短时间内多条 tool_call 只 toast 一次', async () => {
    const conversation: ColleagueConversation = {
      async *runChat() {
        yield {
          type: 'agent.tool_call',
          payload: { toolCalls: [{ name: 'web.search' }] },
        };
        yield {
          type: 'agent.tool_call',
          payload: { toolCalls: [{ name: 'web.fetch' }, { name: 'web.search' }] },
        };
        yield {
          type: 'agent.tool_call',
          payload: { toolCalls: [{ name: 'time.get' }] },
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
    const progress = events.filter((event) => event.type === 'progress');
    expect(progress).toHaveLength(1);
    expect(progress[0]?.text).toBe('正在检索网页');
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it('进度：相同 coding.run 文案即使隔 20s 也只 toast 一次', async () => {
    let now = 1_700_000_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const conversation: ColleagueConversation = {
        async *runChat() {
          yield {
            type: 'agent.tool_call',
            payload: { toolCalls: [{ name: 'coding.run' }] },
          };
          now += 25_000;
          yield {
            type: 'agent.tool_call',
            payload: { toolCalls: [{ name: 'coding.run' }] },
          };
          now += 25_000;
          yield {
            type: 'agent.tool_call',
            payload: { toolCalls: [{ name: 'coding.run' }] },
          };
          yield { type: 'chat.done', payload: { text: '写完了' } };
        },
      };
      const { office } = await makeOffice();
      const events: ColleagueTaskEvent[] = [];
      office.onEvent((event) => events.push(event));
      office.attachConversation(conversation);
      await office.delegate('xiaohei', '写代码');
      await waitFor(() => events.some((event) => event.type === 'done'));
      const progress = events.filter((event) => event.type === 'progress');
      expect(progress).toHaveLength(1);
      expect(progress[0]?.text).toBe('正在写代码');
    } finally {
      spy.mockRestore();
    }
  });

  it('进度：搜索后过 20s 写代码会 toast 两次', async () => {
    let now = 1_700_000_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const conversation: ColleagueConversation = {
        async *runChat() {
          yield {
            type: 'agent.tool_call',
            payload: { toolCalls: [{ name: 'filesystem.search' }] },
          };
          now += 25_000;
          yield {
            type: 'agent.tool_call',
            payload: { toolCalls: [{ name: 'coding.run' }] },
          };
          yield { type: 'chat.done', payload: { text: '好了' } };
        },
      };
      const { office } = await makeOffice();
      const events: ColleagueTaskEvent[] = [];
      office.onEvent((event) => events.push(event));
      office.attachConversation(conversation);
      await office.delegate('xiaohei', '先搜再写');
      await waitFor(() => events.some((event) => event.type === 'done'));
      const progress = events
        .filter((event) => event.type === 'progress')
        .map((event) => event.text);
      expect(progress).toEqual(['正在搜索文件', '正在写代码']);
    } finally {
      spy.mockRestore();
    }
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
