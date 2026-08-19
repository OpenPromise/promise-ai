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
