import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  isIncompleteColleagueReply,
  parseColleagueId,
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
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
  const offices: ColleagueOffice[] = [];

  afterEach(async () => {
    for (const office of offices.splice(0)) office.close();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeOffice(
    options: { store?: InMemorySessionStore; runTask?: RunTaskFn; gitRepoDir?: string | null } = {},
  ) {
    const mailboxDir = await mkdtemp(path.join(tmpdir(), 'mailboxes-'));
    dirs.push(mailboxDir);
    const store = options.store ?? new InMemorySessionStore();
    const runners = stubRunners(options.runTask);
    const office = new ColleagueOffice({
      store,
      runners,
      mailboxDir,
      gitRepoDir: options.gitRepoDir ?? null,
    });
    offices.push(office);
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
      'mail.ask',
      'mail.send',
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
      'mail.ask',
      'mail.send',
    ]);
    expect(colleagueToolAllowlist('xiaozhi')).toEqual([
      'filesystem.search',
      'memory.list',
      'memory.remember',
      'web.search',
      'web.fetch',
      'github.search_repos',
      'time.get',
      'mail.ask',
      'mail.send',
    ]);
    for (const id of COLLEAGUE_IDS) {
      expect(colleagueToolAllowlist(id)).toContain('mail.ask');
      expect(colleagueToolAllowlist(id)).toContain('mail.send');
      expect(colleagueToolAllowlist(id, { nested: true })).not.toContain('mail.ask');
      expect(colleagueToolAllowlist(id, { nested: true })).not.toContain('mail.send');
    }
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
    expect(office.listMailbox('xiaohei')[0]?.status).toBe('queued');
    expect(office.listMailbox('xiaohei')[0]?.taskId).toBe(record.id);
    expect(events[0]).toMatchObject({
      type: 'started',
      colleague: '小黑',
      taskId: record.id,
    });
    expect(captured).toHaveLength(0);

    const sessionId = office.getSessionId('xiaohei')!;
    const before = await store.getSession(sessionId);
    expect(before.messages).toHaveLength(0);

    await waitFor(() => captured.length === 1);
    expect(office.listMailbox('xiaohei')[0]?.status).toBe('running');
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
    expect(captured[1]?.userMessage).toContain('禁止说「等她下一条」');
    expect(captured[1]?.userMessage).toContain('这封信就是终稿');
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

  it('parseColleagueId 接受中文名与短 id', () => {
    expect(parseColleagueId('小真')).toBe('xiaozhen');
    expect(parseColleagueId('xiaozhen')).toBe('xiaozhen');
    expect(parseColleagueId('小美')).toBe('xiaomei');
    expect(parseColleagueId('xiaohei')).toBe('xiaohei');
    expect(parseColleagueId('小夜')).toBeUndefined();
    expect(parseColleagueId('nobody')).toBeUndefined();
  });

  it('office.ask：小美问小真拿到回信；from=xiaomei；无 wrap-up、无 done 事件', async () => {
    const captured: Array<{ sessionId: string; userMessage: string; toolAllowlist?: string[] }> = [];
    const conversation: ColleagueConversation = {
      async *runChat(input) {
        captured.push(input);
        if (input.userMessage.startsWith('【同事回信】')) {
          yield { type: 'chat.done', payload: { text: '不该跑验收' } };
          return;
        }
        if (input.userMessage.startsWith('【小美来信】')) {
          yield {
            type: 'agent.tool_call',
            payload: { toolCalls: [{ name: 'filesystem.search' }] },
          };
          yield { type: 'chat.done', payload: { text: '视觉可以再收一点，对比度够。' } };
          return;
        }
        yield { type: 'chat.done', payload: { text: '小美还在做' } };
      },
    };
    const { office } = await makeOffice({
      runTask: async () => {
        throw new Error('conversation 路径不应调用 runner');
      },
    });
    const events: ColleagueTaskEvent[] = [];
    office.onEvent((event) => events.push(event));
    office.attachConversation(conversation);

    const hubSessionId = 'weixin-hub-ask';
    const parent = await office.delegate('xiaomei', '做小真主页', { hubSessionId });
    await waitFor(() => office.listMailbox('xiaomei')[0]?.status === 'done', 1000);

    const asked = await office.ask('xiaozhen', '视觉能不能再收一点', { from: 'xiaomei' });
    expect(asked.status).toBe('success');
    expect(asked.result).toContain('视觉可以再收一点');

    const zhenMail = office.listMailbox('xiaozhen')[0];
    expect(zhenMail?.from).toBe('xiaomei');
    expect(zhenMail?.to).toBe('xiaozhen');
    expect(zhenMail?.nested).toBe(true);
    expect(zhenMail?.hubSessionId).toBe(hubSessionId);
    expect(zhenMail?.reply).toContain('视觉可以再收一点');
    expect(zhenMail?.chain).toEqual(['xiaomei']);

    const zhenSession = office.getSessionId('xiaozhen')!;
    const zhenCalls = captured.filter((row) => row.sessionId === zhenSession);
    expect(zhenCalls).toHaveLength(1);
    expect(zhenCalls[0]?.userMessage).toBe('【小美来信】\n视觉能不能再收一点');
    expect(zhenCalls[0]?.toolAllowlist).toEqual(colleagueToolAllowlist('xiaozhen', { nested: true }));
    expect(zhenCalls[0]?.toolAllowlist).not.toContain('mail.ask');
    expect(zhenCalls[0]?.toolAllowlist).not.toContain('mail.send');

    expect(captured.some((row) => row.userMessage.startsWith('【同事回信】') && row.userMessage.includes('小真'))).toBe(false);
    expect(events.filter((event) => event.type === 'done' && event.taskId === asked.id)).toHaveLength(
      0,
    );
    expect(events.some((event) => event.type === 'progress' && event.colleague === '小真')).toBe(
      true,
    );
    // 小美自己的派单可以有 done；小真这封 ask 不能有
    expect(events.some((event) => event.type === 'done' && event.taskId === parent.id)).toBe(true);
  });

  it('nested ask 被拒绝：小真回答小美时不能再问小美', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const conversation: ColleagueConversation = {
      async *runChat(input) {
        if (input.userMessage.startsWith('【小美来信】')) {
          await gate;
          yield { type: 'chat.done', payload: { text: '小真答完了' } };
          return;
        }
        yield { type: 'chat.done', payload: { text: 'ok' } };
      },
    };
    const { office } = await makeOffice({
      runTask: async () => {
        throw new Error('不应走 runner');
      },
    });
    office.attachConversation(conversation);

    const pending = office.ask('xiaozhen', '帮我看下对比度', { from: 'xiaomei' });
    await waitFor(() => office.listMailbox('xiaozhen')[0]?.status === 'running', 1000);
    await expect(office.ask('xiaomei', '那你再问我？', { from: 'xiaozhen' })).rejects.toThrow(
      /不能再问/,
    );
    await expect(office.sendFrom('xiaozhen', 'xiaohei', '转给小黑')).rejects.toThrow(/不能再转交/);
    release();
    const done = await pending;
    expect(done.status).toBe('success');
  });

  it('mail.send 从小美到小黑：写信、返回 taskId、记录 chain；小黑再转小美被拒', async () => {
    const captured: Array<{ userMessage: string; sessionId: string }> = [];
    const conversation: ColleagueConversation = {
      async *runChat(input) {
        captured.push({ userMessage: input.userMessage, sessionId: input.sessionId });
        if (input.userMessage.startsWith('【同事回信】')) {
          yield { type: 'chat.done', payload: { text: '小夜：小黑把实现交来了。' } };
          return;
        }
        yield { type: 'chat.done', payload: { text: '小黑做完了' } };
      },
    };
    const { office } = await makeOffice({
      runTask: async () => {
        throw new Error('不应走 runner');
      },
    });
    const events: ColleagueTaskEvent[] = [];
    office.onEvent((event) => events.push(event));
    office.attachConversation(conversation);

    await office.delegate('xiaomei', '出 DESIGN_SPEC', { hubSessionId: 'weixin-hub-send' });
    await waitFor(() => office.listMailbox('xiaomei')[0]?.status === 'done', 1000);

    const record = await office.sendFrom('xiaomei', 'xiaohei', '按 spec 实现首页');
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.status).toBe('running');
    const heMail = office.listMailbox('xiaohei')[0];
    expect(heMail?.from).toBe('xiaomei');
    expect(heMail?.to).toBe('xiaohei');
    expect(heMail?.chain).toEqual(['xiaomei']);
    expect(heMail?.hubSessionId).toBe('weixin-hub-send');
    expect(heMail?.nested).toBeUndefined();
    expect(heMail?.taskId).toBe(record.id);

    await waitFor(() => events.some((event) => event.type === 'done' && event.taskId === record.id), 1000);
    expect(office.listMailbox('xiaohei')[0]?.status).toBe('done');
    expect(captured.some((row) => row.userMessage === '【小美来信】\n按 spec 实现首页')).toBe(true);
    expect(captured.some((row) => row.userMessage.startsWith('【同事回信】'))).toBe(true);
    const done = events.find((event) => event.type === 'done' && event.taskId === record.id);
    expect(done?.result).toContain('小黑把实现交来了');

    await expect(office.sendFrom('xiaohei', 'xiaomei', '退回给你')).rejects.toThrow(/打转/);
  });

  it('isIncompleteColleagueReply：DSML 与短进度 stub 为半成品；验收表里的自检不是', () => {
    const dsml =
      '两份设计文档已落盘。现在做交付前自检 + git 提交…\n' +
      `<\uFF5CDSML\uFF5Ctool_calls>\n<invoke name="coding_run"></invoke>\n</tool_calls>`;
    expect(isIncompleteColleagueReply(dsml)).toBe(true);
    expect(isIncompleteColleagueReply('现在做交付前自检 + git 提交…')).toBe(true);
    expect(isIncompleteColleagueReply('接下来补一笔自检就交。')).toBe(true);
    expect(isIncompleteColleagueReply('两份设计文档已落盘。现在做交付前自检 + git 提交…')).toBe(
      true,
    );
    const qaTable = [
      '## 验收',
      '| 项 | 结果 |',
      '| 对比度 | 通过 |',
      '| 交付前自检 | 全部通过 |',
      '结论：可以交付，不用再派。要点是深色档案室与夜间可读。',
      '还核对了按钮热区和空态文案，表格里的自检只是 QA 记录不是进度预告。',
      '补充：主页深色情报档案室、夜间对比度、空态与错误态文案都过了，不需要再派小美。',
      '交互：夜间模式切换、档案检索空态、错误态文案都过了，结论维持不用再派。',
    ].join('\n');
    expect(qaTable.length).toBeGreaterThan(160);
    expect(isIncompleteColleagueReply(qaTable)).toBe(false);
    expect(isIncompleteColleagueReply('结论：主页 v2 已交，不用再派。')).toBe(false);
  });

  it('不完整 DSML 回信触发一次催交；催交完整则 mailbox 用第二封，wrap-up 带禁止等下一条', async () => {
    const dsml =
      '两份设计文档已落盘。现在做交付前自检 + git 提交…\n' +
      `<\uFF5CDSML\uFF5Ctool_calls>\n<invoke name="coding_run"></invoke>\n</tool_calls>`;
    const captured: Array<{
      sessionId: string;
      userMessage: string;
      toolAllowlist?: string[];
      toolBudget?: number;
      headless?: boolean;
    }> = [];
    const conversation: ColleagueConversation = {
      async *runChat(input) {
        captured.push(input);
        if (input.userMessage.startsWith('【小夜催交】')) {
          yield {
            type: 'chat.done',
            payload: {
              text: '结论：主页 v2 与 DESIGN_SPEC 已落盘。要点：深色情报档案室。不用再派。',
            },
          };
          return;
        }
        if (input.userMessage.startsWith('【同事回信】')) {
          yield {
            type: 'chat.done',
            payload: { text: '小美把主页设计交来了，不用再派。' },
          };
          return;
        }
        yield { type: 'chat.done', payload: { text: dsml } };
      },
    };
    const { office } = await makeOffice({
      runTask: async () => {
        throw new Error('不应走 runner');
      },
    });
    const events: ColleagueTaskEvent[] = [];
    office.onEvent((event) => events.push(event));
    office.attachConversation(conversation);

    const record = await office.delegate('xiaomei', '做小知主页', { hubSessionId: 'hub-dsml' });
    await waitFor(() => events.some((event) => event.type === 'done'), 1000);

    const nudge = captured.filter((row) => row.userMessage.startsWith('【小夜催交】'));
    expect(nudge).toHaveLength(1);
    expect(nudge[0]?.sessionId).toBe(office.getSessionId('xiaomei'));
    expect(nudge[0]?.headless).toBe(true);
    expect(nudge[0]?.toolAllowlist).toEqual([]);
    expect(nudge[0]?.toolBudget).toBe(0);

    const mail = office.listMailbox('xiaomei')[0];
    expect(mail?.status).toBe('done');
    expect(mail?.reply).toContain('主页 v2 与 DESIGN_SPEC');
    expect(mail?.reply).not.toContain('tool_calls');
    expect(mail?.reply).not.toContain('DSML');
    expect(office.getTask(record.id)?.status).toBe('success');

    const wrap = captured.find((row) => row.userMessage.startsWith('【同事回信】'));
    expect(wrap?.userMessage).toContain('禁止说「等她下一条」');
    expect(wrap?.userMessage).toContain('这封信就是终稿');
    expect(wrap?.userMessage).toContain('已完成');
    expect(wrap?.userMessage).not.toContain('tool_calls');
    const done = events.find((event) => event.type === 'done');
    expect(done?.result).toContain('小美把主页设计交来了');
  });

  it('催交仍不完整则保留首封（剥 XML）并标 failed，wrap-up 按没交完', async () => {
    const dsml =
      '两份设计文档已落盘。现在做交付前自检 + git 提交…\n' +
      `<\uFF5CDSML\uFF5Ctool_calls>\n</tool_calls>`;
    const captured: string[] = [];
    const conversation: ColleagueConversation = {
      async *runChat(input) {
        captured.push(input.userMessage);
        if (input.userMessage.startsWith('【小夜催交】')) {
          yield { type: 'chat.done', payload: { text: '现在做交付前自检…' } };
          return;
        }
        if (input.userMessage.startsWith('【同事回信】')) {
          yield { type: 'chat.done', payload: { text: '小美这单没交完，已知落了两份设计文档。' } };
          return;
        }
        yield { type: 'chat.done', payload: { text: dsml } };
      },
    };
    const { office } = await makeOffice({
      runTask: async () => {
        throw new Error('不应走 runner');
      },
    });
    const events: ColleagueTaskEvent[] = [];
    office.onEvent((event) => events.push(event));
    office.attachConversation(conversation);
    await office.delegate('xiaomei', '做小知主页', { hubSessionId: 'hub-dsml-fail' });
    await waitFor(() => events.some((event) => event.type === 'done'), 1000);

    expect(captured.some((msg) => msg.startsWith('【小夜催交】'))).toBe(true);
    const mail = office.listMailbox('xiaomei')[0];
    expect(mail?.status).toBe('failed');
    expect(mail?.reply).toContain('两份设计文档已落盘');
    expect(mail?.reply).not.toContain('tool_calls');
    const wrap = captured.find((msg) => msg.startsWith('【同事回信】'));
    expect(wrap).toContain('已失败');
    expect(wrap).toContain('禁止说「等她下一条」');
    const done = events.find((event) => event.type === 'done');
    expect(done?.status).toBe('failed');
    expect(done?.result).toContain('没交完');
  });

  it('验收表提到自检的完整简报不催交', async () => {
    const qaTable = [
      '## 验收',
      '| 项 | 结果 |',
      '| 对比度 | 通过 |',
      '| 交付前自检 | 全部通过 |',
      '结论：可以交付，不用再派。要点是深色档案室与夜间可读。',
      '还核对了按钮热区和空态文案，表格里的自检只是 QA 记录不是进度预告。',
    ].join('\n');
    const captured: string[] = [];
    const conversation: ColleagueConversation = {
      async *runChat(input) {
        captured.push(input.userMessage);
        if (input.userMessage.startsWith('【同事回信】')) {
          yield { type: 'chat.done', payload: { text: '小真验收过了。' } };
          return;
        }
        yield { type: 'chat.done', payload: { text: qaTable } };
      },
    };
    const { office } = await makeOffice({
      runTask: async () => {
        throw new Error('不应走 runner');
      },
    });
    const events: ColleagueTaskEvent[] = [];
    office.onEvent((event) => events.push(event));
    office.attachConversation(conversation);
    await office.delegate('xiaozhen', '回归主页', { hubSessionId: 'hub-qa' });
    await waitFor(() => events.some((event) => event.type === 'done'), 1000);
    expect(captured.some((msg) => msg.startsWith('【小夜催交】'))).toBe(false);
    expect(office.listMailbox('xiaozhen')[0]?.status).toBe('done');
    expect(office.listMailbox('xiaozhen')[0]?.reply).toContain('交付前自检');
  });

  it('enqueue-only：delegate 返回时 runChat 还没跑；worker tick 后信标 done 并有回信', async () => {
    const captured: string[] = [];
    const conversation: ColleagueConversation = {
      async *runChat(input) {
        captured.push(input.userMessage);
        yield { type: 'chat.done', payload: { text: '回信：已看过' } };
      },
    };
    const { office } = await makeOffice({
      runTask: async () => {
        throw new Error('不应走 runner');
      },
    });
    office.attachConversation(conversation);
    const record = await office.delegate('xiaohei', '请回信');
    expect(office.listMailbox('xiaohei')[0]?.status).toBe('queued');
    expect(captured).toHaveLength(0);
    expect(record.status).toBe('running');

    await waitFor(() => office.listMailbox('xiaohei')[0]?.status === 'done');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe('【小夜来信】\n请回信');
    expect(office.listMailbox('xiaohei')[0]?.reply).toContain('已看过');
    expect(office.getTask(record.id)?.status).toBe('success');
  });

  it('同一人两封信按序单飞：小黑两封从不重叠 runChat', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const gates: Array<() => void> = [];
    const seen: string[] = [];
    const conversation: ColleagueConversation = {
      async *runChat(input) {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        seen.push(input.userMessage);
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        concurrent -= 1;
        yield { type: 'chat.done', payload: { text: `完成：${input.userMessage}` } };
      },
    };
    const { office } = await makeOffice({
      runTask: async () => {
        throw new Error('不应走 runner');
      },
    });
    office.attachConversation(conversation);
    await office.delegate('xiaohei', '第一封');
    await office.delegate('xiaohei', '第二封');
    await waitFor(() => gates.length === 1);
    expect(maxConcurrent).toBe(1);
    const statuses = office.listMailbox('xiaohei').map((item) => item.status);
    expect(statuses).toEqual(['running', 'queued']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('第一封');

    gates[0]?.();
    await waitFor(() => gates.length === 2);
    expect(maxConcurrent).toBe(1);
    expect(office.listMailbox('xiaohei')[0]?.status).toBe('done');
    expect(office.listMailbox('xiaohei')[1]?.status).toBe('running');

    gates[1]?.();
    await waitFor(() => office.listMailbox('xiaohei').every((item) => item.status === 'done'));
    expect(maxConcurrent).toBe(1);
    expect(seen[1]).toContain('第二封');
  });

  it('小美和小黑同时入队：两人 worker 并行跑', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const started = new Set<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const conversation: ColleagueConversation = {
      async *runChat(input) {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        started.add(input.sessionId);
        await gate;
        concurrent -= 1;
        yield { type: 'chat.done', payload: { text: 'ok' } };
      },
    };
    const { office } = await makeOffice({
      runTask: async () => {
        throw new Error('不应走 runner');
      },
    });
    office.attachConversation(conversation);
    await office.delegate('xiaomei', '出视觉');
    await office.delegate('xiaohei', '写代码');
    await waitFor(() => started.size === 2);
    expect(maxConcurrent).toBe(2);
    expect(started).toEqual(
      new Set([office.getSessionId('xiaomei')!, office.getSessionId('xiaohei')!]),
    );
    release();
    await waitFor(
      () =>
        office.listMailbox('xiaomei')[0]?.status === 'done' &&
        office.listMailbox('xiaohei')[0]?.status === 'done',
    );
  });

  it('mail.ask：小美等小真 worker 回信；小真 from=xiaomei；无 wrap-up/done；小美自己的信仍在跑', async () => {
    let releaseMei!: () => void;
    const meiGate = new Promise<void>((resolve) => {
      releaseMei = resolve;
    });
    const captured: Array<{ sessionId: string; userMessage: string; toolAllowlist?: string[] }> = [];
    const conversation: ColleagueConversation = {
      async *runChat(input) {
        captured.push(input);
        if (input.userMessage.startsWith('【同事回信】')) {
          yield { type: 'chat.done', payload: { text: '不该跑验收' } };
          return;
        }
        if (input.userMessage.startsWith('【小美来信】')) {
          yield { type: 'chat.done', payload: { text: '对比度够，可以再收一点。' } };
          return;
        }
        if (input.userMessage.startsWith('【小夜来信】')) {
          await meiGate;
          yield { type: 'chat.done', payload: { text: '小美主页做完了' } };
          return;
        }
        yield { type: 'chat.done', payload: { text: 'ok' } };
      },
    };
    const { office } = await makeOffice({
      runTask: async () => {
        throw new Error('不应走 runner');
      },
    });
    const events: ColleagueTaskEvent[] = [];
    office.onEvent((event) => events.push(event));
    office.attachConversation(conversation);

    const parent = await office.delegate('xiaomei', '做小真主页', { hubSessionId: 'weixin-hub-ask-parallel' });
    await waitFor(() => captured.some((row) => row.userMessage.startsWith('【小夜来信】')));
    expect(office.listMailbox('xiaomei')[0]?.status).toBe('running');

    const asked = await office.ask('xiaozhen', '视觉能不能再收一点', { from: 'xiaomei' });
    expect(asked.status).toBe('success');
    expect(asked.result).toContain('可以再收一点');
    expect(office.listMailbox('xiaomei')[0]?.status).toBe('running');

    const zhenMail = office.listMailbox('xiaozhen')[0];
    expect(zhenMail?.from).toBe('xiaomei');
    expect(zhenMail?.to).toBe('xiaozhen');
    expect(zhenMail?.nested).toBe(true);
    expect(zhenMail?.hubSessionId).toBe('weixin-hub-ask-parallel');
    expect(zhenMail?.reply).toContain('可以再收一点');

    const zhenSession = office.getSessionId('xiaozhen')!;
    const zhenCalls = captured.filter((row) => row.sessionId === zhenSession);
    expect(zhenCalls).toHaveLength(1);
    expect(zhenCalls[0]?.toolAllowlist).toEqual(colleagueToolAllowlist('xiaozhen', { nested: true }));
    expect(zhenCalls[0]?.toolAllowlist).not.toContain('mail.ask');
    expect(zhenCalls[0]?.toolAllowlist).not.toContain('mail.send');
    expect(
      captured.some((row) => row.userMessage.startsWith('【同事回信】') && row.userMessage.includes('小真')),
    ).toBe(false);
    expect(events.filter((event) => event.type === 'done' && event.taskId === asked.id)).toHaveLength(0);

    releaseMei();
    await waitFor(() => office.listMailbox('xiaomei')[0]?.status === 'done');
    expect(events.some((event) => event.type === 'done' && event.taskId === parent.id)).toBe(true);
  });

  it('重启 reconcile：残留 running 退回 queued，不标失败', async () => {
    const mailboxDir = await mkdtemp(path.join(tmpdir(), 'mailboxes-'));
    dirs.push(mailboxDir);
    const leftover = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      from: 'xiaoye',
      to: 'xiaohei',
      body: '重启前没跑完',
      createdAt: new Date().toISOString(),
      status: 'running',
      taskId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      reply: '半成品回信',
    };
    const queued = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      from: 'xiaoye',
      to: 'xiaohei',
      body: '还在排队',
      createdAt: new Date().toISOString(),
      status: 'queued',
      taskId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeeee',
    };
    await writeFile(
      path.join(mailboxDir, 'xiaohei.json'),
      JSON.stringify([leftover, queued], null, 2),
      'utf8',
    );
    const store = new InMemorySessionStore();
    const office = new ColleagueOffice({ store, runners: stubRunners(), mailboxDir, gitRepoDir: null });
    offices.push(office);
    await office.ensureSessions();
    await office.hydrate();

    const items = office.listMailbox('xiaohei');
    expect(items).toHaveLength(2);
    expect(items[0]?.status).toBe('queued');
    expect(items[0]?.reply).toBeUndefined();
    expect(items[0]?.body).toBe('重启前没跑完');
    expect(items[1]?.status).toBe('queued');
    expect(items.every((item) => item.status !== 'failed')).toBe(true);
    expect(items.some((item) => (item.reply ?? '').includes('进程重启'))).toBe(false);
    expect(office.getTask(leftover.taskId)).toBeUndefined();
  });

  it('完整成功后把本任务新建文件自动提交；开始就脏且 mtime 未变的 leftover 不入库', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const repo = await mkdtemp(path.join(tmpdir(), 'office-git-'));
    dirs.push(repo);
    await execFileAsync('git', ['init', '-b', 'main', repo], { windowsHide: true });
    await writeFile(path.join(repo, 'README.md'), 'init\n', 'utf8');
    await execFileAsync('git', ['-C', repo, 'add', 'README.md'], { windowsHide: true });
    await execFileAsync(
      'git',
      ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'],
      { windowsHide: true },
    );
    await writeFile(path.join(repo, 'leftover.md'), 'already dirty\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 30));

    const conversation: ColleagueConversation = {
      async *runChat(input) {
        if (input.userMessage.startsWith('【同事回信】')) {
          yield { type: 'chat.done', payload: { text: '小真把主页交来了。' } };
          return;
        }
        await writeFile(path.join(repo, 'xiaozhen-index.html'), '<h1>v2</h1>\n', 'utf8');
        yield { type: 'chat.done', payload: { text: '结论：主页 v2 已落盘。不用再派。' } };
      },
    };
    const { office } = await makeOffice({ gitRepoDir: repo });
    const events: ColleagueTaskEvent[] = [];
    office.onEvent((event) => events.push(event));
    office.attachConversation(conversation);

    await office.delegate('xiaozhen', '做小真主页 v2', { hubSessionId: 'hub-git' });
    await waitFor(() => events.some((event) => event.type === 'done'), 4000);

    const mail = office.listMailbox('xiaozhen')[0];
    expect(mail?.status).toBe('done');
    expect(mail?.reply).toMatch(/已提交但未推送/);
    const log = await execFileAsync('git', ['-C', repo, 'log', '-1', '--format=%s%n%an'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(log.stdout).toContain('docs/feat(小真): 做小真主页 v2');
    expect(log.stdout).toContain('Promise AI Bot');
    const show = await execFileAsync('git', ['-C', repo, 'show', '--name-only', '--pretty=format:', 'HEAD'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(show.stdout).toContain('xiaozhen-index.html');
    expect(show.stdout).not.toContain('leftover.md');
    const wrap = events.find((event) => event.type === 'done');
    expect(wrap?.result).toBeTruthy();
  });

  it('nested mail.ask 不自动提交对方工作区新文件', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const repo = await mkdtemp(path.join(tmpdir(), 'office-git-ask-'));
    dirs.push(repo);
    await execFileAsync('git', ['init', '-b', 'main', repo], { windowsHide: true });
    await writeFile(path.join(repo, 'README.md'), 'init\n', 'utf8');
    await execFileAsync('git', ['-C', repo, 'add', 'README.md'], { windowsHide: true });
    await execFileAsync(
      'git',
      ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'],
      { windowsHide: true },
    );

    const conversation: ColleagueConversation = {
      async *runChat(input) {
        if (input.userMessage.startsWith('【小美来信】')) {
          await writeFile(path.join(repo, 'ask-notes.md'), 'from nested ask\n', 'utf8');
          yield { type: 'chat.done', payload: { text: '对比度够。' } };
          return;
        }
        if (input.userMessage.startsWith('【同事回信】')) {
          yield { type: 'chat.done', payload: { text: '不该验收小真。' } };
          return;
        }
        yield { type: 'chat.done', payload: { text: '小美做完了，结论清楚，不用再派。' } };
      },
    };
    const { office } = await makeOffice({ gitRepoDir: repo });
    office.attachConversation(conversation);
    await office.delegate('xiaomei', '做主页', { hubSessionId: 'hub-git-ask' });
    await waitFor(() => office.listMailbox('xiaomei')[0]?.status === 'done', 4000);

    const asked = await office.ask('xiaozhen', '对比度够吗', { from: 'xiaomei' });
    expect(asked.status).toBe('success');
    const log = await execFileAsync('git', ['-C', repo, 'log', '--oneline'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(log.stdout).not.toContain('ask-notes');
    const status = await execFileAsync('git', ['-C', repo, 'status', '--porcelain'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(status.stdout).toContain('ask-notes.md');
  });

  it('半成品催交失败后不提交本任务新建文件', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const repo = await mkdtemp(path.join(tmpdir(), 'office-git-fail-'));
    dirs.push(repo);
    await execFileAsync('git', ['init', '-b', 'main', repo], { windowsHide: true });
    await writeFile(path.join(repo, 'README.md'), 'init\n', 'utf8');
    await execFileAsync('git', ['-C', repo, 'add', 'README.md'], { windowsHide: true });
    await execFileAsync(
      'git',
      ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'],
      { windowsHide: true },
    );
    const dsml =
      '现在做交付前自检…\n' +
      `<\uFF5CDSML\uFF5Ctool_calls>\n</tool_calls>`;
    const conversation: ColleagueConversation = {
      async *runChat(input) {
        if (input.userMessage.startsWith('【小夜催交】')) {
          yield { type: 'chat.done', payload: { text: '现在做交付前自检…' } };
          return;
        }
        if (input.userMessage.startsWith('【同事回信】')) {
          yield { type: 'chat.done', payload: { text: '小美这单没交完。' } };
          return;
        }
        await writeFile(path.join(repo, 'half.md'), 'half\n', 'utf8');
        yield { type: 'chat.done', payload: { text: dsml } };
      },
    };
    const { office } = await makeOffice({ gitRepoDir: repo });
    const events: ColleagueTaskEvent[] = [];
    office.onEvent((event) => events.push(event));
    office.attachConversation(conversation);
    await office.delegate('xiaomei', '做设计', { hubSessionId: 'hub-git-fail' });
    await waitFor(() => events.some((event) => event.type === 'done'), 4000);
    expect(office.listMailbox('xiaomei')[0]?.status).toBe('failed');
    const log = await execFileAsync('git', ['-C', repo, 'log', '--oneline'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(log.stdout.trim().split('\n')).toHaveLength(1);
    const status = await execFileAsync('git', ['-C', repo, 'status', '--porcelain'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(status.stdout).toContain('half.md');
  });

});
