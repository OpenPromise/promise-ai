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
