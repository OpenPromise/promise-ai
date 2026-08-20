import { describe, expect, it, vi } from 'vitest';
import type { ChatChunk, ChatInput, GenerateResult, LLMProvider } from '@personal-ai/llm';
import { InMemoryMemoryStore, InMemorySessionStore } from '@personal-ai/memory';
import { ToolRegistry } from '@personal-ai/tools';
import { ApprovalRegistry } from './approval.js';
import {
  collectPersistentContext,
  ConversationService,
  pruneToolResult,
  repairToolResultPairing,
} from './conversation.js';
import { InMemoryProfileStore } from '@personal-ai/memory';

describe('ConversationService', () => {
  it('用户画像注入持久上下文', async () => {
    const memory = new InMemoryMemoryStore();
    const profile = new InMemoryProfileStore();
    await profile.upsertEntry('default', {
      key: '称呼',
      value: '小夜',
      category: 'fact',
    });
    await profile.upsertEntry('default', {
      key: '作息',
      value: '夜猫子',
      category: 'habit',
    });
    const context = await collectPersistentContext(memory, profile);
    expect(context).toContain('用户画像');
    expect(context).toContain('[fact] 称呼：小夜');
    expect(context).toContain('[habit] 作息：夜猫子');
  });

  it('LLM 工具名下划线化传输，tool_calls 返回时还原为真实名执行', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    const tools = new ToolRegistry();
    tools.register({
      name: 'cloud.instance_status',
      description: '查询云服务器状态',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      async execute() {
        return { ok: true, data: { state: 'RUNNING', ip: '122.152.209.182' } };
      },
    });

    const wireNamesSeen: string[] = [];
    const assistantToolCallsSeen: string[] = [];
    let callSeq = 0;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'deepseek-test',
      configured: true,
      async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
        callSeq += 1;
        wireNamesSeen.push(...(input.tools ?? []).map((t) => t.function.name));
        const assistant = input.messages.find((m) => m.role === 'assistant');
        if (assistant?.tool_calls) {
          assistantToolCallsSeen.push(...assistant.tool_calls.map((c) => c.function.name));
        }
        if (callSeq === 1) {
          yield {
            delta: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'cloud_instance_status', arguments: '{}' }],
          };
          return;
        }
        yield { delta: '服务器运行中，IP 122.152.209.182。' };
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
      autoApproveAll: true,
    });

    let finalText = '';
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '看看服务器状态',
    })) {
      if (envelope.type === 'chat.done') {
        finalText = (envelope.payload as { text?: string }).text ?? '';
      }
    }

    // 发给 LLM 的工具名必须符合 ^[a-zA-Z0-9_-]+$（无点号）
    expect(wireNamesSeen.length).toBeGreaterThan(0);
    for (const name of wireNamesSeen) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
    expect(wireNamesSeen).toContain('cloud_instance_status');
    // 历史回放时 assistant.tool_calls 同样下划线化
    expect(assistantToolCallsSeen).toContain('cloud_instance_status');
    // 真实名工具被实际执行
    const refreshed = await store.getSession(session.id);
    expect(
      refreshed.messages.some(
        (m) => m.role === 'tool' && m.content.includes('"state":"RUNNING"'),
      ),
    ).toBe(true);
    // 会话历史里保存的是真实工具名（带点号），供下次回放还原
    const storedCall = refreshed.messages.find((m) => m.role === 'assistant' && m.toolCalls);
    expect(storedCall?.toolCalls?.[0]?.name).toBe('cloud.instance_status');
    expect(finalText).toContain('服务器运行中');
  });

  it('auto-approves all tools when autoApproveAll is enabled', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    const tools = new ToolRegistry();
    tools.register({
      name: 'danger.run',
      description: '危险操作',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 3,
      async execute() {
        return { ok: true, data: { ran: true } };
      },
    });

    let callSeq = 0;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'deepseek-test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        callSeq += 1;
        if (callSeq === 1) {
          yield {
            delta: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'danger.run', arguments: '{}' }],
          };
          return;
        }
        yield { delta: '已执行危险操作。' };
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
      autoApproveAll: true,
    });

    const types: string[] = [];
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '执行危险操作',
    })) {
      types.push(envelope.type);
    }
    expect(types).not.toContain('permission.request');
    const refreshed = await store.getSession(session.id);
    expect(
      refreshed.messages.some((m) => m.role === 'tool' && m.content.includes('"ran":true')),
    ).toBe(true);
  });

  it('对话正常结束后触发异步画像抽取（fire-and-forget）', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    const tools = new ToolRegistry();
    const profileIngest = vi.fn();
    const llm: LLMProvider = {
      name: 'fake',
      model: 'deepseek-test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        yield { delta: '记住了。' };
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
      profileIngest,
    });
    for await (const _envelope of service.runChat({
      sessionId: session.id,
      userMessage: '我叫夜夜，记住我',
    })) {
      // drain
    }
    expect(profileIngest).toHaveBeenCalledWith('我叫夜夜，记住我');
  });

  it('toolAllowlist 拒绝白名单外的工具', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    const tools = new ToolRegistry();
    tools.register({
      name: 'secret.run',
      description: '危险',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      async execute() {
        return { ok: true, data: { ran: true } };
      },
    });
    let callSeq = 0;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'deepseek-test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        callSeq += 1;
        if (callSeq === 1) {
          yield {
            delta: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'secret.run', arguments: '{}' }],
          };
          return;
        }
        yield { delta: '完成了。' };
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
    for await (const _envelope of service.runChat({
      sessionId: session.id,
      userMessage: '执行',
      toolAllowlist: ['time.get'],
    })) {
      // drain
    }
    const refreshed = await store.getSession(session.id);
    expect(
      refreshed.messages.some((m) => m.role === 'tool' && m.content.includes('白名单')),
    ).toBe(true);
  });

  it('toolBudget 超限熔断停止', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    const tools = new ToolRegistry();
    tools.register({
      name: 'time.get',
      description: '时间',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      async execute() {
        return { ok: true, data: { now: '2026' } };
      },
    });
    let callSeq = 0;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'deepseek-test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        callSeq += 1;
        if (callSeq <= 2) {
          yield {
            delta: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: `call_${callSeq}`, name: 'time.get', arguments: '{}' }],
          };
          return;
        }
        yield { delta: '' };
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
    let doneNote = '';
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '跑',
      toolBudget: 1,
    })) {
      if (envelope.type === 'chat.done') {
        doneNote = (envelope.payload as { text?: string }).text ?? '';
      }
    }
    expect(doneNote).toContain('预算超限');
  });

  it('模型只出推理不出正文时，用兜底文案避免静默空回复', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    const tools = new ToolRegistry();
    const llm: LLMProvider = {
      name: 'fake',
      model: 'deepseek-test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        yield { delta: '' };
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

    let doneText = '';
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '说点什么',
    })) {
      if (envelope.type === 'chat.done') {
        doneText = (envelope.payload as { text?: string }).text ?? '';
      }
    }
    expect(doneText).toContain('未生成可见回复');
    const refreshed = await store.getSession(session.id);
    expect(refreshed.messages.at(-1)?.content).toContain('未生成可见回复');
  });

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

  it('injects persistent goals and feedback into the system prompt', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    const memory = new InMemoryMemoryStore();
    await memory.add({
      kind: 'semantic',
      content: '[goal] 帮助用户减肥：三个月减 5 公斤',
    });
    await memory.add({
      kind: 'episodic',
      content: '[feedback] 用户反馈回复太长（规则：控制篇幅）',
    });

    let captured: ChatInput['messages'] | undefined;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'qwen-test',
      configured: true,
      async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
        captured = input.messages;
        yield { delta: '好的，我会持续关注。' };
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
      memory,
    });

    for await (const _envelope of service.runChat({
      sessionId: session.id,
      userMessage: '你好',
    })) {
      // drain
    }

    const systemContent = (captured ?? [])
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(systemContent).toContain('[goal] 帮助用户减肥');
    expect(systemContent).toContain('[feedback] 用户反馈回复太长');
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
