import { describe, expect, it, vi } from 'vitest';
import type { ChatChunk, ChatInput, GenerateResult, LLMProvider } from '@personal-ai/llm';
import { InMemoryMemoryStore, InMemorySessionStore } from '@personal-ai/memory';
import { ToolRegistry } from '@personal-ai/tools';
import { ApprovalRegistry } from './approval.js';
import {
  collectPersistentContext,
  containsDsmlToolXml,
  ConversationService,
  pruneToolResult,
  repairToolResultPairing,
  stripDsmlToolXml,
} from './conversation.js';
import { InMemoryProfileStore, InMemoryTimelineStore } from '@personal-ai/memory';

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

  it('事件时间线注入持久上下文', async () => {
    const memory = new InMemoryMemoryStore();
    const timeline = new InMemoryTimelineStore();
    await timeline.addEvent({ type: 'cloud', summary: '开放端口 8080' });
    const context = await collectPersistentContext(memory, undefined, timeline);
    expect(context).toContain('最近发生的事件时间线');
    expect(context).toContain('[cloud]');
    expect(context).toContain('开放端口 8080');
  });

  it('按 tag 注入目标/反馈（不依赖内容前缀），旧数据前缀回退', async () => {
    const memory = new InMemoryMemoryStore();
    // 带 tag 但内容不以前缀开头：仍应按 tag 注入
    await memory.add({ kind: 'semantic', content: '三个月减 5 公斤', tag: 'goal' });
    await memory.add({ kind: 'episodic', content: '回复太长，控制篇幅', tag: 'feedback' });
    // 旧数据：无 tag 但内容带前缀，走前缀回退
    await memory.add({ kind: 'semantic', content: '[goal] 帮助用户早起' });
    await memory.add({ kind: 'episodic', content: '[feedback] 别在深夜发通知' });

    const context = await collectPersistentContext(memory);
    expect(context).toContain('三个月减 5 公斤');
    expect(context).toContain('回复太长，控制篇幅');
    expect(context).toContain('帮助用户早起');
    expect(context).toContain('别在深夜发通知');
  });

  it('对话结束后写入 chat 时间线事件', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    const timeline = new InMemoryTimelineStore();
    const llm: LLMProvider = {
      name: 'fake',
      model: 'deepseek-test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        yield { delta: '好的。' };
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
      timeline,
    });
    for await (const _envelope of service.runChat({
      sessionId: session.id,
      userMessage: '帮我看看服务器',
    })) {
      // drain
    }
    const events = await timeline.listEvents();
    expect(events.some((e) => e.type === 'chat' && e.summary.includes('帮我看看服务器'))).toBe(
      true,
    );
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
        yield { delta: '根据已有材料：当前时间为 2026。' };
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
    expect(doneNote).toContain('根据已有材料');
    expect(doneNote).not.toMatch(/^工具预算超限/);
  });

  it('toolAllowlist 拒绝的调用不计入 toolBudget', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    const tools = new ToolRegistry();
    let pingExecuted = 0;
    tools.register({
      name: 'time.get',
      description: '时间',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      async execute() {
        return { ok: true, data: { now: '2026' } };
      },
    });
    tools.register({
      name: 'ping.ok',
      description: '探测',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      async execute() {
        pingExecuted += 1;
        return { ok: true, data: { pong: true } };
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
            toolCalls: [{ id: 'call_denied', name: 'time.get', arguments: '{}' }],
          };
          return;
        }
        if (callSeq === 2) {
          yield {
            delta: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_ok', name: 'ping.ok', arguments: '{}' }],
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
    let doneNote = '';
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '跑',
      toolAllowlist: ['ping.ok'],
      toolBudget: 1,
    })) {
      if (envelope.type === 'chat.done') {
        doneNote = (envelope.payload as { text?: string }).text ?? '';
      }
    }
    expect(pingExecuted).toBe(1);
    expect(doneNote).toContain('完成了');
    expect(doneNote).not.toContain('预算超限');
    const refreshed = await store.getSession(session.id);
    expect(
      refreshed.messages.some((m) => m.role === 'tool' && m.content.includes('白名单')),
    ).toBe(true);
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
    expect(typeof refreshed.metadata?.compactedAt).toBe('string');
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

  it('repairToolResultPairing 修复顺序错乱：tool 响应被 user 消息隔开', () => {
    // 并发竞态残留：assistant(tool_calls) 之后插入了 user 消息，tool 响应在后
    const repaired = repairToolResultPairing([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'tool.a', arguments: '{}' } },
        ],
      },
      { role: 'user', content: '你还在吗' },
      { role: 'assistant', content: '（回复生成失败：xxx）' },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_a' },
      { role: 'user', content: '继续' },
    ]);
    // assistant(tool_calls) 后必须紧跟 tool 响应，user 消息被延迟到配对之后
    expect(repaired[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_a' });
    const roles = repaired.map((m) => m.role);
    expect(roles.indexOf('tool')).toBeLessThan(roles.lastIndexOf('user'));
    expect(repaired.filter((m) => m.role === 'user').length).toBe(2);
    expect(repaired.some((m) => m.role === 'tool' && m.tool_call_id === 'call_a')).toBe(true);
  });

  it('repairToolResultPairing 多轮工具调用保持各自配对顺序', () => {
    const repaired = repairToolResultPairing([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'tool.one', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: '{"ok":1}', tool_call_id: 'call_1' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_2', type: 'function', function: { name: 'tool.two', arguments: '{}' } },
        ],
      },
      { role: 'user', content: '插队消息' },
      { role: 'tool', content: '{"ok":2}', tool_call_id: 'call_2' },
      { role: 'user', content: '结束' },
    ]);
    expect(repaired[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_2' });
    expect(repaired[4]).toMatchObject({ role: 'user', content: '插队消息' });
    const callIds = repaired.filter((m) => m.tool_call_id).map((m) => m.tool_call_id);
    expect(callIds).toEqual(['call_1', 'call_2']);
  });

  it('repairToolResultPairing 丢弃孤儿 tool 消息（assistant 已被压缩）', () => {
    const repaired = repairToolResultPairing([
      { role: 'user', content: '[历史对话摘要] ...' },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'orphan_1' },
      { role: 'user', content: '继续' },
    ]);
    expect(repaired.some((m) => m.role === 'tool')).toBe(false);
    expect(repaired.filter((m) => m.role === 'user').length).toBe(2);
  });

  it('同一会话并发请求串行执行（工具间隙发消息不再产生错乱历史）', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    const order: string[] = [];
    let releaseFirstChat!: () => void;
    const firstChatGate = new Promise<void>((resolve) => {
      releaseFirstChat = resolve;
    });
    const llm: LLMProvider = {
      name: 'fake',
      model: 'test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        order.push('llm');
        await firstChatGate;
        yield { delta: 'done' };
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
    const drain = async (message: string) => {
      for await (const _ of service.runChat({ sessionId: session.id, userMessage: message })) {
        // drain
      }
    };
    const first = drain('第一条');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = drain('第二条');
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 第二个请求被串行锁挡住，尚未进入 LLM
    expect(order).toEqual(['llm']);
    releaseFirstChat();
    await Promise.all([first, second]);
    expect(order).toEqual(['llm', 'llm']);
    const messages = (await store.getSession(session.id)).messages;
    expect(messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      '第一条',
      '第二条',
    ]);
  });

  // ── 派单不变量（反向锁定）──────────────────────────────────────────
  // 派单已交回小夜自主决定：程序不再对回复文字做硬校验，也不再注入
  // tool_choice=required 强制补调（旧守卫会把复述/条件句误判成"假派单"，
  // 反而制造出用户没要求的派单）。派单确认由 weixin-bridge 在真实工具
  // 调用时推送（🔧 已派给小黑），不依赖模型文字。以下两条锁定相反方向的
  // 不变量：回复里出现派单表述、但用户没下达明确派单指令时，绝不自动派单。

  it('回复含"已派给小黑"但用户未下达派单指令时不自动派单（只跑 1 轮 LLM）', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    let delegated = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'engineer.delegate',
      description: '派给小黑',
      inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
      permissionLevel: 1,
      async execute() {
        delegated += 1;
        return { ok: true, data: { text: '小黑完成' } };
      },
    });

    let callSeq = 0;
    let toolChoiceSeen: unknown = 'unset';
    const llm: LLMProvider = {
      name: 'fake',
      model: 'test',
      configured: true,
      async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
        callSeq += 1;
        toolChoiceSeen = input.toolChoice;
        // 闲聊回复里带完成态派单字样（旧守卫会据此强制补调派单工具）
        yield { delta: '好的，收到！上次那活早已派给小黑，任务在后台跑着，有新需求随时喊我。' };
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
    for await (const _ of service.runChat({
      sessionId: session.id,
      userMessage: '好的好的，收到了',
    })) {
      // drain
    }

    // 只跑 1 轮 LLM、没有自动派单，且对话不再用 tool_choice 做派单强制
    expect(callSeq).toBe(1);
    expect(delegated).toBe(0);
    expect(toolChoiceSeen).toBeUndefined();
  });

  it('复述/条件句（"我确实说了让小黑开干了，但那是条件句"）不自动派单', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    let delegated = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'engineer.delegate',
      description: '派给小黑',
      inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
      permissionLevel: 1,
      async execute() {
        delegated += 1;
        return { ok: true, data: { text: '小黑完成' } };
      },
    });

    let callSeq = 0;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        callSeq += 1;
        // 复述用户的条件句（引语 + 过去时"说了…了"），不是真的要派单
        yield {
          delta: "我确实说了'让小黑开干'了，但那是条件句，等你确认再派。",
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
    for await (const _ of service.runChat({
      sessionId: session.id,
      userMessage: '能报名的话我就让小黑开干',
    })) {
      // drain
    }

    expect(callSeq).toBe(1);
    expect(delegated).toBe(0);
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

  it('轻量核查：声称"已派给小黑"但未调工具时注入提示，模型可澄清而非被强制派单', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    let delegated = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'engineer.delegate',
      description: '派给小黑',
      inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
      permissionLevel: 1,
      async execute() {
        delegated += 1;
        return { ok: true, data: { text: '小黑完成' } };
      },
    });

    let callSeq = 0;
    let checkPromptSeen = false;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'test',
      configured: true,
      async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
        callSeq += 1;
        if (callSeq === 1) {
          // 第一轮：声称已派但没调工具（DeepSeek 老毛病）
          yield { delta: '收到，已派给小黑！让它查端口。' };
          return;
        }
        // 第二轮：收到核查提示后澄清，而不是被迫派单
        checkPromptSeen = input.messages.some(
          (m) => m.role === 'user' && m.content.includes('事实核查'),
        );
        yield { delta: '澄清一下：我还没有派单，刚才是口误，这就说明情况。' };
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
    let finalText = '';
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '让小优查下端口',
    })) {
      if (envelope.type === 'chat.done') {
        finalText = (envelope.payload as { text?: string }).text ?? '';
      }
    }

    expect(callSeq).toBe(2);
    expect(checkPromptSeen).toBe(true);
    expect(delegated).toBe(0); // 澄清路径不会真派单
    expect(finalText).toContain('还没有派单');
  });

  it('轻量核查：声称已派未调工具时，模型可补派（delegated=1）', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    let delegated = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'engineer.delegate',
      description: '派给小黑',
      inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
      permissionLevel: 1,
      async execute() {
        delegated += 1;
        return { ok: true, data: { text: '小黑完成' } };
      },
    });

    let callSeq = 0;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        callSeq += 1;
        if (callSeq === 1) {
          yield { delta: '收到，已派给小黑！让它查端口。' };
          return;
        }
        if (callSeq === 2) {
          yield {
            delta: '',
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'call_delegate',
                name: 'engineer_delegate',
                arguments: JSON.stringify({ task: '查端口' }),
              },
            ],
          };
          return;
        }
        yield { delta: '这次真派了，任务在后台跑。' };
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
    for await (const _ of service.runChat({
      sessionId: session.id,
      userMessage: '让小优查下端口',
    })) {
      // drain
    }
    expect(callSeq).toBe(3);
    expect(delegated).toBe(1);
  });

  it('轻量核查不误伤：引用/计划表述（"之前已派给小黑""这就派"）不触发', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    let callSeq = 0;
    let checkPromptSeen = false;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'test',
      configured: true,
      async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
        callSeq += 1;
        checkPromptSeen = input.messages.some(
          (m) => m.role === 'user' && m.content.includes('事实核查'),
        );
        yield { delta: '之前已派给小黑的任务还在跑，新的我这就派。' };
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
    for await (const _ of service.runChat({
      sessionId: session.id,
      userMessage: '看看小黑任务',
    })) {
      // drain
    }
    expect(callSeq).toBe(1);
    expect(checkPromptSeen).toBe(false);
  });

  it('非 headless 成功 *.delegate 且已有口头文字：不再开下一轮 LLM，chat.done 用已流式文本', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    let delegated = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'designer.delegate',
      description: '派给小美',
      inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
      permissionLevel: 1,
      async execute() {
        delegated += 1;
        return { ok: true, data: { text: '小美已接单' } };
      },
    });

    let callSeq = 0;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        callSeq += 1;
        if (callSeq === 1) {
          yield {
            delta: '好，我让小美去设计。',
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'call_delegate',
                name: 'designer_delegate',
                arguments: JSON.stringify({ task: '设计主页' }),
              },
            ],
          };
          return;
        }
        yield { delta: '小真没有独立信箱，我再查一下能不能让小美写信……' };
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
    let finalText = '';
    let doneNote: string | undefined;
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '让小美去给小真设计一个主页',
    })) {
      if (envelope.type === 'chat.done') {
        const payload = envelope.payload as { text?: string; note?: string };
        finalText = payload.text ?? '';
        doneNote = payload.note;
      }
    }
    expect(delegated).toBe(1);
    expect(callSeq).toBe(1);
    expect(finalText).toBe('好，我让小美去设计。');
    expect(doneNote).toBeUndefined();
    const messages = (await store.getSession(session.id)).messages;
    expect(messages.some((m) => (m.content ?? '').includes('没有独立信箱'))).toBe(false);
  });

  it('非 headless 成功 *.delegate 但本轮无口头文字：只再跑一次无工具收束', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    let delegated = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'designer.delegate',
      description: '派给小美',
      inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
      permissionLevel: 1,
      async execute() {
        delegated += 1;
        return { ok: true, data: { text: '小美已接单' } };
      },
    });

    let callSeq = 0;
    let secondHadTools: boolean | undefined;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'test',
      configured: true,
      async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
        callSeq += 1;
        if (callSeq === 1) {
          yield {
            delta: '',
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'call_delegate',
                name: 'designer_delegate',
                arguments: JSON.stringify({ task: '设计主页' }),
              },
            ],
          };
          return;
        }
        secondHadTools = Array.isArray(input.tools) && input.tools.length > 0;
        yield { delta: '已经派给小美了。' };
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
    let finalText = '';
    let doneNote: string | undefined;
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '让小美设计主页',
    })) {
      if (envelope.type === 'chat.done') {
        const payload = envelope.payload as { text?: string; note?: string };
        finalText = payload.text ?? '';
        doneNote = payload.note;
      }
    }
    expect(delegated).toBe(1);
    expect(callSeq).toBe(2);
    expect(secondHadTools).toBe(false);
    expect(finalText).toBe('已经派给小美了。');
    expect(doneNote).toBeUndefined();
  });

  it('headless 成功 *.delegate 后继续工具轮（同事/验收路径不变）', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    let delegated = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'engineer.delegate',
      description: '派给小黑',
      inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
      permissionLevel: 1,
      async execute() {
        delegated += 1;
        return { ok: true, data: { text: '小黑已接单' } };
      },
    });

    let callSeq = 0;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        callSeq += 1;
        if (callSeq === 1) {
          yield {
            delta: '派给小黑。',
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'call_delegate',
                name: 'engineer_delegate',
                arguments: JSON.stringify({ task: '修 bug' }),
              },
            ],
          };
          return;
        }
        yield { delta: 'headless 继续说完。' };
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
    let finalText = '';
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '【小夜来信】修 bug',
      headless: true,
    })) {
      if (envelope.type === 'chat.done') {
        finalText = (envelope.payload as { text?: string }).text ?? '';
      }
    }
    expect(delegated).toBe(1);
    expect(callSeq).toBe(2);
    expect(finalText).toBe('headless 继续说完。');
  });


  it('识别并剥掉正文里的 DSML / tool XML', () => {
    const blob =
      '两份设计文档已落盘。现在做交付前自检 + git 提交…\n' +
      `<\uFF5CDSML\uFF5Ctool_calls>\n<invoke name="coding_run"></invoke>\n</tool_calls>`;
    expect(containsDsmlToolXml(blob)).toBe(true);
    expect(containsDsmlToolXml('<tool_calls>{"name":"coding.run"}</tool_calls>')).toBe(true);
    expect(containsDsmlToolXml('结论：主页可以交付，不用再派。')).toBe(false);
    expect(stripDsmlToolXml(blob)).toBe('两份设计文档已落盘。现在做交付前自检 + git 提交…');
  });

  it('assistant 正文含 DSML 且无 structured toolCalls：再跑一轮无工具，chat.done 用自然语言', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    const tools = new ToolRegistry();
    tools.register({
      name: 'coding.run',
      description: '写代码',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 1,
      async execute() {
        throw new Error('DSML 正文不应触发工具执行');
      },
    });

    let callSeq = 0;
    let secondHadTools: boolean | undefined;
    let secondPrompt = '';
    const llm: LLMProvider = {
      name: 'fake',
      model: 'deepseek-test',
      configured: true,
      async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
        callSeq += 1;
        if (callSeq === 1) {
          yield {
            delta:
              '两份设计文档已落盘。现在做交付前自检 + git 提交…\n' +
              `<\uFF5CDSML\uFF5Ctool_calls>\n<invoke name="coding_run"></invoke>\n</tool_calls>`,
          };
          return;
        }
        secondHadTools = Array.isArray(input.tools) && input.tools.length > 0;
        const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
        secondPrompt = lastUser?.content ?? '';
        yield { delta: '结论：DESIGN_SPEC 已落盘，主页深色情报档案室。不用再派。' };
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
    let finalText = '';
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '做小知主页',
      headless: true,
    })) {
      if (envelope.type === 'chat.done') {
        finalText = (envelope.payload as { text?: string }).text ?? '';
      }
    }
    expect(callSeq).toBe(2);
    expect(secondHadTools).toBe(false);
    expect(secondPrompt).toContain('不要再调用工具');
    expect(finalText).toContain('DESIGN_SPEC 已落盘');
    expect(finalText).not.toContain('tool_calls');
    expect(finalText).not.toContain('DSML');
    const stored = (await store.getSession(session.id)).messages.map((m) => m.content).join('\n');
    expect(stored).not.toContain('<tool_calls>');
    expect(stored).not.toMatch(/<\uFF5CDSML/);
  });

  it('DSML 补救轮仍是垃圾：chat.done 只用正文前缀，不含 XML', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    let callSeq = 0;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'deepseek-test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        callSeq += 1;
        yield {
          delta:
            '两份设计文档已落盘。现在做交付前自检…\n' +
            `<\uFF5CDSML\uFF5Ctool_calls>\n</tool_calls>`,
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
    let finalText = '';
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '做小知主页',
      headless: true,
    })) {
      if (envelope.type === 'chat.done') {
        finalText = (envelope.payload as { text?: string }).text ?? '';
      }
    }
    expect(callSeq).toBe(2);
    expect(finalText).toBe('两份设计文档已落盘。现在做交付前自检…');
    expect(finalText).not.toContain('tool_calls');
  });

  it('非 headless 派单失败不提前结束，可继续工具轮', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ systemPrompt: '你是助理。' });
    let delegated = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'designer.delegate',
      description: '派给小美',
      inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
      permissionLevel: 1,
      async execute() {
        delegated += 1;
        return { ok: false, error: '收件箱忙' };
      },
    });

    let callSeq = 0;
    const llm: LLMProvider = {
      name: 'fake',
      model: 'test',
      configured: true,
      async *chat(): AsyncIterable<ChatChunk> {
        callSeq += 1;
        if (callSeq === 1) {
          yield {
            delta: '我去派给小美。',
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'call_delegate',
                name: 'designer_delegate',
                arguments: JSON.stringify({ task: '设计主页' }),
              },
            ],
          };
          return;
        }
        yield { delta: '派单没成功，我再想想办法。' };
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
    let finalText = '';
    for await (const envelope of service.runChat({
      sessionId: session.id,
      userMessage: '让小美设计主页',
    })) {
      if (envelope.type === 'chat.done') {
        finalText = (envelope.payload as { text?: string }).text ?? '';
      }
    }
    expect(delegated).toBe(1);
    expect(callSeq).toBe(2);
    expect(finalText).toContain('没成功');
  });
});

function failLlm(): never {
  throw new Error('fetch failed');
}
