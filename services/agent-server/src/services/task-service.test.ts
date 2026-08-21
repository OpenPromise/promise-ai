import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InMemorySessionStore,
  InMemoryMemoryStore,
  InMemoryTaskStore,
  type Task,
} from '@personal-ai/memory';
import type { ChatChunk, ChatInput, LLMProvider } from '@personal-ai/llm';
import { ToolRegistry } from '@personal-ai/tools';
import { ApprovalRegistry } from './approval.js';
import { ConversationService } from './conversation.js';
import { isTaskDue, TaskService, validateCronSchedule } from './task-service.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'test',
    schedule: '*/2 * * * *',
    action: '检查天气',
    sessionId: 'session-1',
    enabled: true,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('cron scheduling helpers', () => {
  it('validates cron expressions', () => {
    expect(validateCronSchedule('0 9 * * *')).toBeNull();
    expect(validateCronSchedule('not-a-cron')).toContain('无效');
  });

  it('detects due tasks at the next occurrence and prevents re-fire', () => {
    // every 2 minutes: at 00:00 the next occurrence is 00:02
    const task = makeTask();
    expect(isTaskDue(task, new Date('2026-08-19T00:01:00.000Z'))).toBe(false);
    expect(isTaskDue(task, new Date('2026-08-19T00:02:00.000Z'))).toBe(true);
    expect(isTaskDue(task, new Date('2026-08-19T00:02:30.000Z'))).toBe(true);

    // once marked as run (lastRunAt after the occurrence), it is no longer due
    const ran = makeTask({ lastRunAt: '2026-08-19T00:02:10.000Z' });
    expect(isTaskDue(ran, new Date('2026-08-19T00:02:30.000Z'))).toBe(false);
    // the next occurrence (00:04) is due again
    expect(isTaskDue(ran, new Date('2026-08-19T00:04:00.000Z'))).toBe(true);
  });
});

describe('TaskService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs due tasks headlessly and records runs', async () => {
    const tasks = new InMemoryTaskStore();
    const sessions = new InMemorySessionStore();
    const session = await sessions.createSession({ systemPrompt: 'test' });
    await tasks.createTask({
      name: 'daily',
      schedule: '*/1 * * * *',
      action: '检查天气',
      sessionId: session.id,
    });

    const runChat = vi.fn(async function* () {
      yield {
        type: 'chat.token',
        timestamp: new Date().toISOString(),
        sessionId: session.id,
        requestId: 'r1',
        payload: { delta: '今天晴' },
      };
      yield {
        type: 'chat.done',
        timestamp: new Date().toISOString(),
        sessionId: session.id,
        requestId: 'r1',
        payload: { text: '今天晴' },
      };
    });

    const fakeConversation = {
      runChat,
    } as unknown as ConversationService;

    const service = new TaskService({
      tasks,
      sessions,
      conversation: fakeConversation,
      systemPrompt: async () => 'test prompt',
      tickIntervalMs: 30,
    });
    // Make the task due (last run an hour ago) and trigger a tick deterministically.
    const [created] = await tasks.listTasks();
    await tasks.updateTask(created!.id, {
      lastRunAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await service.checkNow();

    service.stop();

    const runs = await tasks.listRuns();
    expect(runs[0]?.status).toBe('success');
    expect(runs[0]?.output).toBe('今天晴');
    // The task was marked as run.
    const [task] = await tasks.listTasks();
    expect(task?.lastRunAt).toBeDefined();
    // The conversation ran in headless mode.
    expect(runChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        userMessage: '检查天气',
        headless: true,
      }),
    );
  });

  it('emits a run event to subscribers after success', async () => {
    const tasks = new InMemoryTaskStore();
    const sessions = new InMemorySessionStore();
    const session = await sessions.createSession({ systemPrompt: 'test' });
    await tasks.createTask({
      name: 'daily',
      schedule: '*/1 * * * *',
      action: '检查天气',
      sessionId: session.id,
    });

    const runChat = vi.fn(async function* () {
      yield {
        type: 'chat.done',
        timestamp: new Date().toISOString(),
        sessionId: session.id,
        requestId: 'r1',
        payload: { text: '今天晴' },
      };
    });
    const fakeConversation = { runChat } as unknown as ConversationService;

    const service = new TaskService({
      tasks,
      sessions,
      conversation: fakeConversation,
      systemPrompt: async () => 'test prompt',
      tickIntervalMs: 30,
    });
    const events: Array<{
      status: string;
      output?: string;
      startedAt?: string;
      finishedAt?: string;
    }> = [];
    const unsubscribe = service.onRun((event) => events.push(event));

    const [created] = await tasks.listTasks();
    await tasks.updateTask(created!.id, {
      lastRunAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await service.checkNow();
    unsubscribe();
    service.stop();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      taskId: created!.id,
      taskName: 'daily',
      action: '检查天气',
      status: 'success',
      output: '今天晴',
    });
    expect(events[0]?.startedAt).toBeDefined();
    expect(events[0]?.finishedAt).toBeDefined();
  });

  it('emits an error event when a task run fails', async () => {
    const tasks = new InMemoryTaskStore();
    const sessions = new InMemorySessionStore();
    const session = await sessions.createSession({ systemPrompt: 'test' });
    await tasks.createTask({
      name: 'failing',
      schedule: '*/1 * * * *',
      action: '会失败的任务',
      sessionId: session.id,
    });

    const fakeConversation = {
      // eslint-disable-next-line require-yield
      runChat: vi.fn(async function* () {
        throw new Error('模拟失败');
      }),
    } as unknown as ConversationService;

    const service = new TaskService({
      tasks,
      sessions,
      conversation: fakeConversation,
      systemPrompt: async () => 'test prompt',
      tickIntervalMs: 30,
    });
    const events: Array<{ status: string; error?: string }> = [];
    service.onRun((event) => events.push(event));

    const [created] = await tasks.listTasks();
    await tasks.updateTask(created!.id, {
      lastRunAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await service.checkNow();
    service.stop();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      taskName: 'failing',
      status: 'error',
      error: '模拟失败',
    });
  });

  it('recreates a missing task session so stale tasks self-heal', async () => {
    const tasks = new InMemoryTaskStore();
    const sessions = new InMemorySessionStore();
    // 任务指向一个不存在的会话（存储切换/清理后的常见情况）
    await tasks.createTask({
      name: 'stale',
      schedule: '*/1 * * * *',
      action: '检查天气',
      sessionId: 'missing-session',
    });

    const runChat = vi.fn(async function* () {
      yield {
        type: 'chat.done',
        timestamp: new Date().toISOString(),
        sessionId: 'whatever',
        requestId: 'r1',
        payload: { text: 'ok' },
      };
    });
    const fakeConversation = { runChat } as unknown as ConversationService;

    const service = new TaskService({
      tasks,
      sessions,
      conversation: fakeConversation,
      systemPrompt: async () => 'test prompt',
      tickIntervalMs: 30,
    });
    const [created] = await tasks.listTasks();
    await tasks.updateTask(created!.id, {
      lastRunAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await service.checkNow();
    service.stop();

    const [task] = await tasks.listTasks();
    expect(task?.sessionId).not.toBe('missing-session');
    expect(runChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: task?.sessionId,
        headless: true,
      }),
    );
    const runs = await tasks.listRuns();
    expect(runs[0]?.status).toBe('success');
  });

  it('records errors when a task run fails', async () => {
    const tasks = new InMemoryTaskStore();
    const sessions = new InMemorySessionStore();
    const session = await sessions.createSession({ systemPrompt: 'test' });
    await tasks.createTask({
      name: 'fail',
      schedule: '*/1 * * * *',
      action: '会失败',
      sessionId: session.id,
    });

    const fakeConversation = {
      // eslint-disable-next-line require-yield
      runChat: async function* () {
        throw new Error('boom');
      },
    } as unknown as ConversationService;

    const service = new TaskService({
      tasks,
      sessions,
      conversation: fakeConversation,
      systemPrompt: async () => 'test prompt',
      tickIntervalMs: 30,
    });
    const [created] = await tasks.listTasks();
    await tasks.updateTask(created!.id, {
      lastRunAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await service.checkNow();
    service.stop();

    const runs = await tasks.listRuns();
    expect(runs[0]?.status).toBe('error');
    expect(runs[0]?.error).toContain('boom');
  });

  it('慢任务不阻塞同 tick 的其它到期任务（有界并发，不再队头阻塞）', async () => {
    const tasks = new InMemoryTaskStore();
    const sessions = new InMemorySessionStore();
    const slowSession = await sessions.createSession({ systemPrompt: 'test' });
    const fastSessionA = await sessions.createSession({ systemPrompt: 'test' });
    const fastSessionB = await sessions.createSession({ systemPrompt: 'test' });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    for (const [name, sessionId] of [
      ['slow', slowSession.id],
      ['fast-a', fastSessionA.id],
      ['fast-b', fastSessionB.id],
    ] as const) {
      await tasks.createTask({ name, schedule: '*/1 * * * *', action: name, sessionId });
    }
    for (const task of await tasks.listTasks()) {
      await tasks.updateTask(task.id, {
        lastRunAt: new Date(Date.now() - 60_000).toISOString(),
      });
    }

    const runChat = vi.fn(function ({ sessionId }: { sessionId: string }) {
      return (async function* () {
        if (sessionId === slowSession.id) await gate;
        yield {
          type: 'chat.done',
          timestamp: new Date().toISOString(),
          sessionId,
          requestId: 'r1',
          payload: { text: 'ok' },
        };
      })();
    });
    const service = new TaskService({
      tasks,
      sessions,
      conversation: { runChat } as unknown as ConversationService,
      systemPrompt: async () => 'test prompt',
      tickIntervalMs: 30,
    });

    const tick = service.checkNow();
    // 慢任务仍卡在 gate 上，但并发上限允许后续任务先跑完（串行实现下这里会超时）
    const deadline = Date.now() + 3000;
    while ((await tasks.listRuns()).length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finishedEarly = await tasks.listRuns();
    expect(finishedEarly.length).toBeGreaterThanOrEqual(2);

    release?.();
    await tick;
    service.stop();

    const runs = await tasks.listRuns();
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run.status === 'success')).toBe(true);
  });

  it('单任务抛错（数据库抖动等）不再终止整个 tick', async () => {
    const tasks = new InMemoryTaskStore();
    const inner = new InMemorySessionStore();
    const healthy = await inner.createSession({ systemPrompt: 'test' });
    // 第一个任务的会话读取抛非 SessionNotFoundError（模拟数据库临时故障）
    const sessions = {
      createSession: (init: Parameters<InMemorySessionStore['createSession']>[0]) =>
        inner.createSession(init),
      getSession: async (id: string) => {
        if (id === 'flaky-session') throw new Error('connection terminated unexpectedly');
        return inner.getSession(id);
      },
    } as unknown as InMemorySessionStore;

    await tasks.createTask({
      name: 'broken',
      schedule: '*/1 * * * *',
      action: '会抛错',
      sessionId: 'flaky-session',
    });
    await tasks.createTask({
      name: 'healthy',
      schedule: '*/1 * * * *',
      action: '正常任务',
      sessionId: healthy.id,
    });
    for (const task of await tasks.listTasks()) {
      await tasks.updateTask(task.id, {
        lastRunAt: new Date(Date.now() - 60_000).toISOString(),
      });
    }

    const runChat = vi.fn(async function* ({ sessionId }: { sessionId: string }) {
      yield {
        type: 'chat.done',
        timestamp: new Date().toISOString(),
        sessionId,
        requestId: 'r1',
        payload: { text: '正常完成' },
      };
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new TaskService({
      tasks,
      sessions,
      conversation: { runChat } as unknown as ConversationService,
      systemPrompt: async () => 'test prompt',
      tickIntervalMs: 30,
      // 并发 1：确保测的是"单任务失败被就地兜住"，而不是靠并发绕过
      maxConcurrentRuns: 1,
    });
    await service.checkNow();
    service.stop();

    const runs = await tasks.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('success');
    expect(runs[0]?.output).toBe('正常完成');
  });

  it('denies L2 tools in headless mode without prompting', async () => {
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register({
      name: 'secret.send',
      description: '敏感操作',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 2,
      async execute() {
        executed += 1;
        return { ok: true };
      },
    });

    let calls = 0;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'qwen-test',
      configured: true,
      async *chat(_input: ChatInput): AsyncIterable<ChatChunk> {
        calls += 1;
        if (calls === 1) {
          yield {
            delta: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'c1', name: 'secret.send', arguments: '{}' }],
          };
          return;
        }
        yield { delta: '任务完成。' };
        yield { delta: '', finishReason: 'stop' };
      },
      async generate() {
        return { text: '' };
      },
    };

    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: 'test' });
    const conversation = new ConversationService({
      store,
      llm,
      tools: registry,
      approvals: new ApprovalRegistry(),
      memory: new InMemoryMemoryStore(),
    });

    const events: Array<{ type: string; payload: unknown }> = [];
    for await (const envelope of conversation.runChat({
      sessionId: session.id,
      userMessage: '执行敏感操作',
      headless: true,
    })) {
      events.push(envelope);
    }

    expect(events.some((event) => event.type === 'permission.request')).toBe(false);
    const toolResult = events.find((event) => event.type === 'agent.tool_result');
    const result = (toolResult?.payload as { result: { error?: string } }).result;
    expect(result?.error).toContain('无人值守');
    expect(executed).toBe(0);
  });
});
