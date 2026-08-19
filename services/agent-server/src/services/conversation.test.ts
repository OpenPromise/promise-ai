import { describe, expect, it } from 'vitest';
import type { ChatChunk, ChatInput, GenerateResult, LLMProvider } from '@personal-ai/llm';
import { InMemoryMemoryStore, InMemorySessionStore } from '@personal-ai/memory';
import { ToolRegistry } from '@personal-ai/tools';
import { ApprovalRegistry } from './approval.js';
import { ConversationService, pruneToolResult, repairToolResultPairing } from './conversation.js';

describe('ConversationService', () => {
  it('compacts long history into a summary and emits agent.state', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    for (let i = 0; i < 65; i++) {
      await store.addMessage(session.id, { role: 'user', content: `第 ${i} 条用户消息` });
      await store.addMessage(session.id, { role: 'assistant', content: `第 ${i} 条回复` });
    }

    let compactionDone = false;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'qwen-test',
      configured: true,
      async *chat(_input: ChatInput): AsyncIterable<ChatChunk> {
        if (!compactionDone) {
          compactionDone = true;
          yield { delta: '早期对话的摘要：用户问了很多问题，助理都回答了。' };
          return;
        }
        yield { delta: '收到，这是最新回复。' };
        yield {
          delta: '',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        };
      },
      async generate(): Promise<GenerateResult> {
        return { text: '' };
      },
    };

    const service = new ConversationService({
      store,
      llm,
      tools: new ToolRegistry(),
      approvals: new ApprovalRegistry(),
      memory: new InMemoryMemoryStore(),
    });

    const envelopes: Array<{ type: string; payload: { state?: string } }> = [];
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '继续',
    })) {
      envelopes.push(envelope as { type: string; payload: { state?: string } });
    }

    // History was trimmed and the summary placed at the front.
    const refreshed = await store.getSession(session.id);
    expect(refreshed.messages.length).toBeLessThan(30);
    expect(refreshed.messages[0]?.content).toContain('[历史对话摘要]');
    expect(refreshed.metadata?.compacted).toBe(true);
    // Recent context and the current turn are preserved.
    expect(refreshed.messages.some((m) => m.content === '第 64 条回复')).toBe(true);
    expect(refreshed.messages.at(-2)?.content).toBe('继续');
    expect(refreshed.messages.at(-1)?.content).toBe('收到，这是最新回复。');

    // Unified state machine events bookend the turn.
    expect(envelopes[0]?.type).toBe('agent.state');
    expect(envelopes[0]?.payload.state).toBe('thinking');
    expect(envelopes.at(-1)?.type).toBe('agent.state');
    expect(envelopes.at(-1)?.payload.state).toBe('listening');
  });

  it('skips compaction when history is short', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    await store.addMessage(session.id, { role: 'user', content: '你好' });

    let calls = 0;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'qwen-test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        calls += 1;
        yield { delta: '你好呀。' };
      },
      async generate(): Promise<GenerateResult> {
        return { text: '' };
      },
    };
    const service = new ConversationService({
      store,
      llm,
      tools: new ToolRegistry(),
      approvals: new ApprovalRegistry(),
      memory: new InMemoryMemoryStore(),
    });

    for await (const _ of service.runChat({ sessionId: session.id, userMessage: '在吗' })) {
      // drain
    }

    expect(calls).toBe(1);
    const refreshed = await store.getSession(session.id);
    expect(refreshed.messages.some((m) => m.content.includes('历史对话摘要'))).toBe(false);
    expect(refreshed.metadata?.compacted).toBeUndefined();
  });

  it('retries transient LLM failures before the first token', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });

    let calls = 0;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'qwen-test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        calls += 1;
        if (calls === 1) throw new Error('fetch failed');
        yield { delta: '重试成功。' };
      },
      async generate(): Promise<GenerateResult> {
        return { text: '' };
      },
    };
    const service = new ConversationService({
      store,
      llm,
      tools: new ToolRegistry(),
      approvals: new ApprovalRegistry(),
      memory: new InMemoryMemoryStore(),
    });

    const envelopes: Array<{ type: string }> = [];
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '你好',
    })) {
      envelopes.push(envelope as { type: string });
    }

    expect(calls).toBe(2);
    expect(envelopes.some((e) => e.type === 'chat.error')).toBe(false);
    const refreshed = await store.getSession(session.id);
    expect(refreshed.messages.at(-1)?.content).toBe('重试成功。');
  });

  it('emits chat.error and returns to listening when the LLM keeps failing', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });

    const llm: LLMProvider = {
      name: 'fake',
      model: 'qwen-test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        failLlm();
        yield { delta: 'unreachable' };
      },
      async generate(): Promise<GenerateResult> {
        return { text: '' };
      },
    };
    const service = new ConversationService({
      store,
      llm,
      tools: new ToolRegistry(),
      approvals: new ApprovalRegistry(),
      memory: new InMemoryMemoryStore(),
    });

    const envelopes: Array<{ type: string; payload: { error?: string; state?: string } }> = [];
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '你好',
    })) {
      envelopes.push(envelope as { type: string; payload: { error?: string; state?: string } });
    }

    const errorEvent = envelopes.find((e) => e.type === 'chat.error');
    expect(errorEvent?.payload.error).toContain('fetch failed');
    expect(envelopes.at(-1)?.type).toBe('agent.state');
    expect(envelopes.at(-1)?.payload.state).toBe('listening');
    const refreshed = await store.getSession(session.id);
    expect(refreshed.messages.at(-1)?.content).toContain('回复生成失败');
  });

  it('prunes oversized tool results before they enter context', () => {
    const short = 'small result';
    expect(pruneToolResult(short)).toBe(short);

    const large = 'x'.repeat(20_000);
    const pruned = pruneToolResult(large);
    expect(pruned.length).toBeLessThan(8192);
    expect(pruned).toContain('已截断');
    expect(pruned.startsWith('x'.repeat(4096))).toBe(true);
    expect(pruned.endsWith('x'.repeat(1024))).toBe(true);
  });

  it('repairs dangling tool calls with synthetic tool results', () => {
    const repaired = repairToolResultPairing([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'filesystem.read', arguments: '{}' },
          },
        ],
      },
    ]);
    expect(repaired.at(-1)?.role).toBe('tool');
    expect(repaired.at(-1)?.tool_call_id).toBe('call_1');
    expect(repaired.at(-1)?.content).toContain('缺失');
  });

  it('stops the loop when the same tool call repeats', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    let executed = 0;
    let callSeq = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'repeat.hit',
      description: 'test tool',
      inputSchema: { type: 'object', properties: {} },
      permissionLevel: 0,
      async execute() {
        executed += 1;
        return { ok: true, data: { hit: true } };
      },
    });
    const llm: LLMProvider = {
      name: 'fake',
      model: 'qwen-test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        callSeq += 1;
        yield {
          delta: '',
          toolCalls: [{ id: `call_${callSeq}`, name: 'repeat.hit', arguments: '{}' }],
        };
      },
      async generate(): Promise<GenerateResult> {
        return { text: '' };
      },
    };
    const service = new ConversationService({
      store,
      llm,
      tools,
      approvals: new ApprovalRegistry(),
      memory: new InMemoryMemoryStore(),
    });

    const envelopes: Array<{ type: string; payload: { text?: string; state?: string } }> = [];
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '重复执行',
    })) {
      envelopes.push(envelope as { type: string; payload: { text?: string; state?: string } });
    }

    // 前 2 次真实执行，第 3 次相同调用被拦截。
    expect(executed).toBe(2);
    const done = envelopes.find((e) => e.type === 'chat.done');
    expect(done?.payload.text).toContain('工具循环');
    expect(envelopes.at(-1)?.type).toBe('agent.state');
    expect(envelopes.at(-1)?.payload.state).toBe('listening');
  });
});

function failLlm(): never {
  throw new Error('fetch failed');
}
