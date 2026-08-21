import { describe, expect, it } from 'vitest';
import {
  InMemoryMemoryStore,
  InMemorySessionStore,
  InMemoryTimelineStore,
} from '@personal-ai/memory';
import type { ChatChunk, GenerateResult, LLMProvider } from '@personal-ai/llm';
import { ConversationService } from './conversation.js';
import { ApprovalRegistry } from './approval.js';
import { ToolRegistry } from '@personal-ai/tools';
import { HookService, summarizeHookPayload } from './hook-service.js';

describe('summarizeHookPayload', () => {
  it('GitHub issue 事件结构化摘要', () => {
    const summary = summarizeHookPayload({
      action: 'opened',
      repository: { full_name: 'OpenPromise/promise-ai' },
      issue: { number: 42, title: '优化部署' },
      sender: { login: 'alice' },
    });
    expect(summary).toContain('GitHub');
    expect(summary).toContain('OpenPromise/promise-ai');
    expect(summary).toContain('opened #42「优化部署」（alice）');
  });

  it('普通 payload 压缩为 JSON 摘要', () => {
    const summary = summarizeHookPayload({ disk: 95, host: 'srv-1' });
    expect(summary).toContain('disk');
  });
});

describe('HookService 事件驱动处理', () => {
  it('外部事件触发 AI 评估并发出 hook.run 事件', async () => {
    const sessions = new InMemorySessionStore();
    const tools = new ToolRegistry();
    const llm: LLMProvider = {
      name: 'fake',
      model: 'test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        yield { delta: '收到，这是一个需要关注的 issue。' };
      },
      async generate(): Promise<GenerateResult> {
        return { text: '' };
      },
    };
    const conversation = new ConversationService({
      store: sessions,
      llm,
      tools,
      approvals: new ApprovalRegistry(),
      memory: new InMemoryMemoryStore(),
    });
    const timeline = new InMemoryTimelineStore();
    const hooks = new HookService({
      conversation,
      sessions,
      systemPrompt: async () => '你是助理。',
      timeline,
    });
    const events: Array<{ hookName: string; status: string; output?: string }> = [];
    hooks.onRun((event) => events.push(event));
    await hooks.handle('github', {
      action: 'opened',
      repository: { full_name: 'OpenPromise/promise-ai' },
      issue: { number: 42, title: '优化部署' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.hookName).toBe('github');
    expect(events[0]?.status).toBe('success');
    expect(events[0]?.output).toContain('关注');
    const timelineEvents = await timeline.listEvents();
    expect(timelineEvents.some((e) => e.type === 'system' && e.summary.includes('github'))).toBe(
      true,
    );
  });

  it('AI 认为无需打扰时输出 HEARTBEAT_OK', async () => {
    const sessions = new InMemorySessionStore();
    const tools = new ToolRegistry();
    const llm: LLMProvider = {
      name: 'fake',
      model: 'test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        yield { delta: 'HEARTBEAT_OK' };
      },
      async generate(): Promise<GenerateResult> {
        return { text: '' };
      },
    };
    const conversation = new ConversationService({
      store: sessions,
      llm,
      tools,
      approvals: new ApprovalRegistry(),
      memory: new InMemoryMemoryStore(),
    });
    const hooks = new HookService({
      conversation,
      sessions,
      systemPrompt: async () => '你是助理。',
    });
    const events: Array<{ output?: string }> = [];
    hooks.onRun((event) => events.push(event));
    await hooks.handle('monitor', { level: 'info' });
    expect(events[0]?.output).toContain('HEARTBEAT_OK');
  });
});

describe('HookService 资源护栏（N-P1-7）', () => {
  function fakeConversation(
    runChat: (input: {
      sessionId: string;
      userMessage: string;
      headless?: boolean;
      signal?: AbortSignal;
    }) => AsyncIterable<{ type: string; payload: unknown }>,
  ): ConversationService {
    return { runChat } as unknown as ConversationService;
  }

  it('同名 hook 复用同一个会话，不再每个 webhook 建一个（会话表无界膨胀）', async () => {
    const sessions = new InMemorySessionStore();
    const seen: string[] = [];
    const hooks = new HookService({
      conversation: fakeConversation(function ({ sessionId }) {
        seen.push(sessionId);
        return (async function* () {
          yield { type: 'chat.done', payload: { text: 'ok' } };
        })();
      }),
      sessions,
      systemPrompt: async () => '你是助理。',
    });
    await hooks.handle('github', { action: 'opened' });
    await hooks.handle('github', { action: 'closed' });
    await hooks.handle('monitor', { level: 'warn' });

    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[0]);
    // 每个 hookName 一个长期会话：两个 hook → 两个会话，而不是三个
    expect(await sessions.listSessions()).toHaveLength(2);
  });

  it('会话被清理后自愈重建（不再永久失败）', async () => {
    const inner = new InMemorySessionStore();
    const sessions = {
      createSession: (init: Parameters<InMemorySessionStore['createSession']>[0]) =>
        inner.createSession(init),
      getSession: (id: string) => inner.getSession(id),
      listSessions: () => inner.listSessions(),
    } as unknown as InMemorySessionStore;
    const seen: string[] = [];
    const hooks = new HookService({
      conversation: fakeConversation(function ({ sessionId }) {
        seen.push(sessionId);
        return (async function* () {
          yield { type: 'chat.done', payload: { text: 'ok' } };
        })();
      }),
      sessions,
      systemPrompt: async () => '你是助理。',
    });
    await hooks.handle('github', { action: 'opened' });
    // 模拟存储侧会话丢失
    hooks.forgetSession('github');
    await hooks.handle('github', { action: 'closed' });
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
  });

  it('单次处理有总超时：超时后 abort runChat 并按失败上报', async () => {
    const sessions = new InMemorySessionStore();
    let sawSignal: AbortSignal | undefined;
    const hooks = new HookService({
      conversation: fakeConversation(function ({ signal }) {
        sawSignal = signal;
        return (async function* () {
          await new Promise<void>((resolve, reject) => {
            if (!signal) return;
            signal.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
            const timer = setTimeout(resolve, 5_000);
            timer.unref?.();
          });
          yield { type: 'chat.done', payload: { text: 'never' } };
        })();
      }),
      sessions,
      systemPrompt: async () => '你是助理。',
      runTimeoutMs: 20,
    });
    const events: Array<{ status: string; error?: string }> = [];
    hooks.onRun((event) => events.push(event));
    await hooks.handle('github', { action: 'opened' });
    expect(sawSignal).toBeDefined();
    expect(events[0]?.status).toBe('error');
  });

  it('并发闸：同时处理的 hook 不超过上限，其余排队', async () => {
    const sessions = new InMemorySessionStore();
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const hooks = new HookService({
      conversation: fakeConversation(function () {
        return (async function* () {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => releases.push(resolve));
          active -= 1;
          yield { type: 'chat.done', payload: { text: 'ok' } };
        })();
      }),
      sessions,
      systemPrompt: async () => '你是助理。',
      maxConcurrentRuns: 2,
    });
    const runs = ['a', 'b', 'c', 'd'].map((name) => hooks.handle(name, {}));
    // 等排队生效
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(peak).toBe(2);
    while (releases.length > 0 || active > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it('排队积压超上限时丢弃并上报错误（CI 风暴不打爆内存）', async () => {
    const sessions = new InMemorySessionStore();
    const releases: Array<() => void> = [];
    const hooks = new HookService({
      conversation: fakeConversation(function () {
        return (async function* () {
          await new Promise<void>((resolve) => releases.push(resolve));
          yield { type: 'chat.done', payload: { text: 'ok' } };
        })();
      }),
      sessions,
      systemPrompt: async () => '你是助理。',
      maxConcurrentRuns: 1,
      maxQueuedRuns: 1,
    });
    const events: Array<{ status: string; error?: string }> = [];
    hooks.onRun((event) => events.push(event));
    const runs = [hooks.handle('a', {}), hooks.handle('b', {}), hooks.handle('c', {})];
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe('error');
    expect(events[0]?.error).toContain('繁忙');
    while (releases.length > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Promise.all(runs);
  });
});
