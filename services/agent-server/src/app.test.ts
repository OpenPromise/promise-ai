import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { loadConfig } from '@personal-ai/config';
import type { AppConfig } from '@personal-ai/config';
import type { PersonaProvider } from '@personal-ai/core';
import type {
  STTProvider,
  TranscriptHandler,
  TTSProvider,
  VoiceGateway,
} from '@personal-ai/elevenlabs';
import type { ChatChunk, ChatInput, GenerateResult, LLMProvider } from '@personal-ai/llm';
import { InMemoryMemoryStore, InMemorySessionStore, type MemoryStore } from '@personal-ai/memory';
import type { AddMessageInput, SessionStore } from '@personal-ai/memory';
import type { Session } from '@personal-ai/types';
import type { QwenRealtimeClient } from '@personal-ai/qwen-realtime';
import { ToolRegistry } from '@personal-ai/tools';
import { buildApp } from './app.js';
import { ApprovalRegistry } from './services/approval.js';
import type { HookService } from './services/hook-service.js';

const testConfig = loadConfig(
  {
    NODE_ENV: 'test',
    PORT: '3001',
    LOG_LEVEL: 'silent',
  },
  { loadDotenv: false },
);

const qwenConfig = loadConfig(
  {
    NODE_ENV: 'test',
    PORT: '3001',
    LOG_LEVEL: 'silent',

    DASHSCOPE_API_KEY: 'sk-ws-test',
    QWEN_VOICE_MODE: 'cascade',
  },
  { loadDotenv: false },
);

const s2sConfig = loadConfig(
  {
    NODE_ENV: 'test',
    PORT: '3001',
    LOG_LEVEL: 'silent',

    DASHSCOPE_API_KEY: 'sk-ws-test',
    QWEN_VOICE_MODE: 's2s',
  },
  { loadDotenv: false },
);

function fakeLLM(configured = true): LLMProvider {
  return {
    name: 'fake',
    model: 'qwen-test',
    configured,
    async *chat(): AsyncIterable<ChatChunk> {
      yield { delta: '你好' };
      yield { delta: '，世界' };
      yield {
        delta: '',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
      };
    },
    async generate(): Promise<GenerateResult> {
      return {
        text: '你好，世界',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
      };
    },
  };
}

const stubPersona: PersonaProvider = {
  async getSystemPrompt() {
    return '你是测试人格：一个自信从容的私人 AI 助理。';
  },
  async getVoiceProfile() {
    return { voiceId: 'test-voice' };
  },
};

const stubTTS: TTSProvider = {
  configured: true,
  async *synthesize() {},
};

function makeStubSTT(handlers: TranscriptHandler[] = []): STTProvider {
  return {
    configured: true,
    audioFormat: 'pcm_16000',
    async start() {},
    async sendAudio() {},
    onTranscript(handler) {
      handlers.push(handler);
    },
    async stop() {},
  };
}

function build(
  config: AppConfig = testConfig,
  llm: LLMProvider = fakeLLM(),
  createVoice: () => VoiceGateway = () => ({ stt: makeStubSTT(), tts: stubTTS }),
  tools: ToolRegistry = new ToolRegistry(),
  approvals: ApprovalRegistry = new ApprovalRegistry({ timeoutMs: 5000 }),
  memory: MemoryStore = new InMemoryMemoryStore(),
  createQwen?: (model: string) => QwenRealtimeClient,
  createTTS: () => TTSProvider = () => stubTTS,
  store: SessionStore = new InMemorySessionStore(),
) {
  return buildApp({
    config,
    store,
    llm,
    persona: stubPersona,
    tools,
    approvals,
    memory,
    createVoice,
    createTTS,
    createQwen,
  });
}

/** Records synthesized texts; yields the given audio chunks. */
function recordingTTS(
  texts: string[],
  chunks: Array<{ data: Buffer; format: string }> = [],
): TTSProvider {
  return {
    configured: true,
    async *synthesize(text, options) {
      texts.push(text);
      for (const chunk of chunks) {
        if (options?.signal?.aborted) return;
        yield chunk;
      }
    },
  };
}

/**
 * Session store whose selected writes are slow: exposes ordering bugs where a
 * fire-and-forget assistant write lands after a later user message (P2-23).
 */
class DelayedWriteSessionStore implements SessionStore {
  readonly #inner = new InMemorySessionStore();
  #writes = 0;

  constructor(
    private readonly delayFor: (input: AddMessageInput, index: number) => number,
  ) {}

  createSession(input?: Parameters<SessionStore['createSession']>[0]): Promise<Session> {
    return this.#inner.createSession(input);
  }

  getSession(sessionId: string): Promise<Session> {
    return this.#inner.getSession(sessionId);
  }

  async addMessage(sessionId: string, input: AddMessageInput): Promise<Session> {
    const delay = this.delayFor(input, this.#writes);
    this.#writes += 1;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return this.#inner.addMessage(sessionId, input);
  }

  updateSession(
    sessionId: string,
    input: Parameters<SessionStore['updateSession']>[1],
  ): Promise<Session> {
    return this.#inner.updateSession(sessionId, input);
  }

  listSessions(): Promise<Session[]> {
    return this.#inner.listSessions();
  }
}

/** LLM that streams one sentence, then throws once the request is aborted. */
function abortAwareLLM(firstDelta: string): LLMProvider {
  return {
    name: 'fake',
    model: 'qwen-test',
    configured: true,
    async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
      yield { delta: firstDelta };
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) {
          resolve();
          return;
        }
        input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted');
    },
    async generate(): Promise<GenerateResult> {
      return { text: firstDelta };
    },
  };
}

/** Minimal QwenRealtimeClient double for route-level integration tests. */
class FakeQwenClient {
  sent: string[] = [];
  sessionUpdate: Record<string, unknown> | undefined;
  readonly #transcript = new Set<(event: { kind: 'partial' | 'final'; text: string }) => void>();
  readonly #assistant = new Set<(delta: string) => void>();
  readonly #audio = new Set<
    (event: { data: Buffer; format: string; sampleRate: number }) => void
  >();
  readonly #responseCreated = new Set<() => void>();
  readonly #responseDone = new Set<
    (event: { status: string; text: string; id?: string }) => void
  >();
  readonly #speechStarted = new Set<() => void>();
  readonly #functionCall = new Set<
    (event: { callId: string; name: string; arguments: string; responseId?: string }) => void
  >();
  readonly #error = new Set<(error: Error) => void>();

  start(): Promise<void> {
    return Promise.resolve();
  }

  updateSession(session: Record<string, unknown>): Promise<void> {
    this.sessionUpdate = session;
    return Promise.resolve();
  }

  sendAudio(chunk: Buffer): void {
    this.sent.push(`audio:${chunk.length}`);
  }

  cancelResponse(): void {
    this.sent.push('cancel');
  }

  createResponse(): void {
    this.sent.push('response.create');
  }

  sendFunctionCallOutput(callId: string, output: string): void {
    this.sent.push(`output:${callId}:${output}`);
  }

  close(): void {
    // noop
  }

  onTranscript(handler: (event: { kind: 'partial' | 'final'; text: string }) => void): void {
    this.#transcript.add(handler);
  }

  onAssistantTranscript(handler: (delta: string) => void): void {
    this.#assistant.add(handler);
  }

  onAudioDelta(
    handler: (event: { data: Buffer; format: string; sampleRate: number }) => void,
  ): void {
    this.#audio.add(handler);
  }

  onResponseCreated(handler: () => void): void {
    this.#responseCreated.add(handler);
  }

  onResponseDone(handler: (event: { status: string; text: string; id?: string }) => void): void {
    this.#responseDone.add(handler);
  }

  onSpeechStarted(handler: () => void): void {
    this.#speechStarted.add(handler);
  }

  onFunctionCall(
    handler: (event: {
      callId: string;
      name: string;
      arguments: string;
      responseId?: string;
    }) => void,
  ): void {
    this.#functionCall.add(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.#error.add(handler);
  }

  onClose(): void {
    // noop
  }

  emitUserFinal(text: string): void {
    for (const handler of this.#transcript) handler({ kind: 'final', text });
  }

  emitPartial(text: string): void {
    for (const handler of this.#transcript) handler({ kind: 'partial', text });
  }

  emitAssistant(delta: string): void {
    for (const handler of this.#assistant) handler(delta);
  }

  emitAudio(base64: string): void {
    for (const handler of this.#audio) {
      handler({ data: Buffer.from(base64, 'base64'), format: 'pcm', sampleRate: 24_000 });
    }
  }

  emitResponseCreated(): void {
    for (const handler of this.#responseCreated) handler();
  }

  emitResponseDone(status: string, text: string, id?: string): void {
    for (const handler of this.#responseDone) handler({ status, text, id });
  }

  emitFunctionCall(callId: string, name: string, argumentsText: string, responseId?: string): void {
    for (const handler of this.#functionCall) {
      handler({ callId, name, arguments: argumentsText, responseId });
    }
  }
}

function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);
}

function scriptedLLM(
  responses: Array<() => AsyncGenerator<ChatChunk>>,
  recordedInputs: ChatInput[] = [],
): LLMProvider {
  let call = 0;
  return {
    name: 'fake',
    model: 'qwen-test',
    configured: true,
    async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
      recordedInputs.push(input);
      const generator = responses[Math.min(call, responses.length - 1)]?.();
      call += 1;
      if (!generator) return;
      for await (const chunk of generator) yield chunk;
    },
    async generate(): Promise<GenerateResult> {
      return { text: '' };
    },
  };
}

describe('agent-server', () => {
  it('serves health', async () => {
    const app = build();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.llm).toEqual({
      provider: 'fake',
      model: 'qwen-test',
      configured: true,
    });
    // 敏感配置不再出现在无鉴权的 /health（P1-18）
    expect(body.autoApproveAll).toBeUndefined();
    expect(body.voiceEnabled).toBeUndefined();
    expect(body.memory).toBeUndefined();
  });

  it('serves the xiaohei welcome page', async () => {
    const app = build();
    const response = await app.inject({ method: 'GET', url: '/xiaohei' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('小黑工程师');
  });

  it('serves the xiaoyou welcome page', async () => {
    const app = build();
    const response = await app.inject({ method: 'GET', url: '/xiaoyou' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('小优');
  });

  it('serves the xiaomei welcome page', async () => {
    const app = build();
    const response = await app.inject({ method: 'GET', url: '/xiaomei' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('小美');
  });

  it('serves xiaohei static assets: /xiaohei/avatar.png as image/png', async () => {
    const app = build();
    const response = await app.inject({ method: 'GET', url: '/xiaohei/avatar.png' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    // PNG 魔数（89 50 4E 47），确认返回的是真实图片字节而非错误 JSON。
    expect(response.rawPayload.subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  it('serves xiaohei trailing slash as index.html', async () => {
    const app = build();
    const response = await app.inject({ method: 'GET', url: '/xiaohei/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('rejects path traversal and missing files in the xiaohei static route', async () => {
    const app = build();
    // 编码的 .. 段（find-my-way 会解码）不得借静态路由读根目录外文件。
    const traversal = await app.inject({ method: 'GET', url: '/xiaohei/..%2Fpackage.json' });
    expect(traversal.statusCode).toBe(404);
    const missing = await app.inject({ method: 'GET', url: '/xiaohei/nope.png' });
    expect(missing.statusCode).toBe(404);
  });

  it('registers the xiaoyou static route (missing asset -> 404, not 401/500)', async () => {
    const app = build();
    const response = await app.inject({ method: 'GET', url: '/xiaoyou/avatar.png' });
    expect(response.statusCode).toBe(404);
  });

  it('registers the xiaomei static route (missing asset -> 404, not 401/500)', async () => {
    const app = build();
    const response = await app.inject({ method: 'GET', url: '/xiaomei/avatar.png' });
    expect(response.statusCode).toBe(404);
  });

  it('creates a session with the persona system prompt', async () => {
    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    const session = response.json();
    expect(session.id).toBeDefined();
    expect(session.systemPrompt).toBe('你是测试人格：一个自信从容的私人 AI 助理。');
    expect(session.messages).toEqual([]);
  });

  it('honors a session-level systemPrompt override', async () => {
    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { systemPrompt: '自定义人格：极简回复。' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().systemPrompt).toBe('自定义人格：极简回复。');
  });

  it('streams chat tokens and persists the conversation', async () => {
    const app = build();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {},
    });
    const sessionId = createResponse.json().id as string;

    const chatResponse = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/chat`,
      payload: { message: '你好' },
    });

    expect(chatResponse.statusCode).toBe(200);
    expect(chatResponse.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(chatResponse.body);
    const types = events.map((event) => event.type);
    expect(types).toContain('chat.token');
    expect(types).toContain('chat.done');

    const text = events
      .filter((event) => event.type === 'chat.token')
      .map((event) => (event.payload as { delta: string }).delta)
      .join('');
    expect(text).toBe('你好，世界');

    const done = events.find((event) => event.type === 'chat.done');
    const usage = (done?.payload as { usage: { outputTokens: number } }).usage;
    expect(usage.outputTokens).toBe(4);

    const sessionResponse = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}`,
    });
    const session = sessionResponse.json();
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[1].role).toBe('assistant');
    expect(session.messages[1].content).toBe('你好，世界');
  });

  it('returns 404 for unknown sessions', async () => {
    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/missing/chat',
      payload: { message: 'hi' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects empty messages', async () => {
    const app = build();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {},
    });
    const sessionId = createResponse.json().id as string;
    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/chat`,
      payload: { message: '' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 503 when the LLM is not configured', async () => {
    const app = build(testConfig, fakeLLM(false));
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {},
    });
    const sessionId = createResponse.json().id as string;
    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/chat`,
      payload: { message: 'hi' },
    });
    expect(response.statusCode).toBe(503);
  });

  it('routes voice over WebSocket: STT -> LLM -> TTS', async () => {
    const transcriptHandlers: TranscriptHandler[] = [];
    const app = build(testConfig, fakeLLM(), () => ({
      stt: makeStubSTT(transcriptHandlers),
      tts: {
        configured: true,
        async *synthesize() {
          yield { data: Buffer.from('fake-mp3-bytes'), format: 'mp3' };
        },
      },
    }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {},
      });
      const sessionId = created.json().id as string;

      const received: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${sessionId}`);
      ws.on('message', (data) => received.push(data.toString()));

      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });

      await waitFor(() => received.some((m) => m.includes('voice.ready')));

      ws.send(Buffer.from('pcm-audio-bytes'));
      transcriptHandlers[0]?.({ kind: 'final', text: '你好', isFinal: true });

      await waitFor(() => received.some((m) => m.includes('tts.end')));

      expect(received.some((m) => m.includes('transcript.final'))).toBe(true);
      expect(received.some((m) => m.includes('agent.thinking'))).toBe(true);
      expect(received.some((m) => m.includes('tts.start'))).toBe(true);
      expect(received.some((m) => m.includes('tts.end'))).toBe(true);
      const audio = received.find((m) => m.includes('audio.chunk'));
      expect(audio).toContain('ZmFrZS1tcDMtYnl0ZXM='); // base64 of fake-mp3-bytes

      const session = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}`,
      });
      const messages = session.json().messages as Array<{ role: string; content: string }>;
      expect(messages.at(-2)?.content).toBe('你好');
      expect(messages.at(-1)?.content).toBe('你好，世界');

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('interrupts an active voice task when the user starts speaking', async () => {
    const transcriptHandlers: TranscriptHandler[] = [];
    let releaseLlm: (() => void) | undefined;
    const llmGate = new Promise<void>((resolve) => {
      releaseLlm = resolve;
    });
    const slowLlm: LLMProvider = {
      name: 'fake',
      model: 'qwen-test',
      configured: true,
      async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
        yield { delta: '好的。' };
        await llmGate;
        if (input.signal?.aborted) return;
        yield { delta: '然后继续说。' };
      },
      async generate() {
        return { text: '好的。然后继续说。' };
      },
    };
    const app = build(testConfig, slowLlm, () => ({
      stt: makeStubSTT(transcriptHandlers),
      tts: {
        configured: true,
        async *synthesize() {
          yield { data: Buffer.from('audio-1'), format: 'pcm' };
        },
      },
    }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {},
      });
      const sessionId = created.json().id as string;

      const received: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${sessionId}`);
      ws.on('message', (data) => received.push(data.toString()));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      await waitFor(() => received.some((m) => m.includes('voice.ready')));

      ws.send(Buffer.from('pcm-audio-bytes'));
      transcriptHandlers[0]?.({ kind: 'final', text: '你好', isFinal: true });

      await waitFor(() => received.some((m) => m.includes('tts.start')));
      expect(received.some((m) => m.includes('audio.chunk'))).toBe(true);

      // The user starts speaking while the agent is still talking.
      transcriptHandlers[0]?.({ kind: 'partial', text: '等等', isFinal: false });

      await waitFor(() => received.some((m) => m.includes('tts.interrupted')));
      expect(received.some((m) => m.includes('tts.end'))).toBe(false);

      releaseLlm?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received.some((m) => m.includes('tts.end'))).toBe(false);

      // The partial reply ("好的。") is persisted so the conversation stays coherent.
      await waitFor(async () => {
        const session = await app.inject({
          method: 'GET',
          url: `/api/sessions/${sessionId}`,
        });
        const messages = session.json().messages as Array<{ role: string; content: string }>;
        return messages.some((m) => m.role === 'assistant' && m.content === '好的。');
      });

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('interrupts via the client control message', async () => {
    const transcriptHandlers: TranscriptHandler[] = [];
    let releaseLlm: (() => void) | undefined;
    const llmGate = new Promise<void>((resolve) => {
      releaseLlm = resolve;
    });
    const slowLlm: LLMProvider = {
      name: 'fake',
      model: 'qwen-test',
      configured: true,
      async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
        yield { delta: '我在说话。' };
        await llmGate;
        if (input.signal?.aborted) return;
        yield { delta: '继续说。' };
      },
      async generate() {
        return { text: '我在说话。继续说。' };
      },
    };
    const app = build(testConfig, slowLlm, () => ({
      stt: makeStubSTT(transcriptHandlers),
      tts: {
        configured: true,
        async *synthesize() {
          yield { data: Buffer.from('audio-1'), format: 'pcm' };
        },
      },
    }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {},
      });
      const sessionId = created.json().id as string;

      const received: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${sessionId}`);
      ws.on('message', (data) => received.push(data.toString()));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      await waitFor(() => received.some((m) => m.includes('voice.ready')));

      ws.send(Buffer.from('pcm-audio-bytes'));
      transcriptHandlers[0]?.({ kind: 'final', text: '你好', isFinal: true });
      await waitFor(() => received.some((m) => m.includes('tts.start')));

      ws.send(JSON.stringify({ type: 'interrupt' }));

      await waitFor(() => received.some((m) => m.includes('tts.interrupted')));
      const interrupted = received.find((m) => m.includes('tts.interrupted'));
      expect(interrupted).toContain('client');
      expect(received.some((m) => m.includes('tts.end'))).toBe(false);

      releaseLlm?.();
      ws.close();
    } finally {
      await app.close();
    }
  });

  it('creates a fresh voice client per websocket connection', async () => {
    let creations = 0;
    const countingApp = build(testConfig, fakeLLM(), () => {
      creations += 1;
      return { stt: makeStubSTT(), tts: stubTTS };
    });
    await countingApp.listen({ port: 0, host: '127.0.0.1' });
    const { port } = countingApp.server.address() as AddressInfo;

    try {
      const sessions: string[] = [];
      for (let i = 0; i < 2; i++) {
        const created = await countingApp.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: {},
        });
        sessions.push(created.json().id as string);
      }

      const sockets: WebSocket[] = [];
      for (const sessionId of sessions) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${sessionId}`);
        sockets.push(ws);
        await new Promise<void>((resolve, reject) => {
          ws.once('open', () => resolve());
          ws.once('error', reject);
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(creations).toBe(2);

      for (const ws of sockets) ws.close();
      await countingApp.close();
    } finally {
      await countingApp.close();
    }
  });

  it('routes voice over WebSocket: Qwen ASR -> LLM -> Qwen TTS', async () => {
    const fakes = new Map<string, FakeQwenClient>();
    const synthesized: string[] = [];
    const app = build(
      qwenConfig,
      fakeLLM(),
      undefined,
      undefined,
      undefined,
      undefined,
      (model) => {
        const fake = new FakeQwenClient();
        fakes.set(model, fake);
        return fake as unknown as QwenRealtimeClient;
      },
      () => recordingTTS(synthesized, [{ data: Buffer.from('fake-mp3-bytes'), format: 'mp3' }]),
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const sessionId = await createSession(app);
      const received: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${sessionId}`);
      ws.on('message', (data) => received.push(data.toString()));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });

      await waitFor(() => received.some((m) => m.includes('voice.ready')));
      const asr = fakes.get(qwenConfig.qwenRealtime.asrModel);
      expect(asr).toBeDefined();

      // ASR session: 16 kHz PCM + server VAD.
      const asrSession = asr?.sessionUpdate as {
        input_audio_format: string;
        sample_rate: number;
        input_audio_transcription: { language: string };
        turn_detection: { type: string; threshold: number; silence_duration_ms: number };
      };
      expect(asrSession.input_audio_format).toBe('pcm');
      expect(asrSession.sample_rate).toBe(16_000);
      expect(asrSession.input_audio_transcription.language).toBe('zh');
      expect(asrSession.turn_detection.type).toBe('server_vad');
      expect(asrSession.turn_detection.silence_duration_ms).toBe(400);

      // User turn: desktop PCM reaches the ASR client, partials stream out.
      ws.send(Buffer.from('pcm-audio-bytes'));
      await waitFor(() => (asr?.sent ?? []).some((entry) => entry.startsWith('audio:')));
      asr?.emitPartial('现在');
      await waitFor(() => received.some((m) => m.includes('transcript.partial')));

      asr?.emitUserFinal('现在几点？');
      await waitFor(() => received.some((m) => m.includes('agent.thinking')));

      // LLM's streamed reply is split into a sentence and synthesized by TTS.
      await waitFor(() => synthesized.includes('你好，世界'));
      expect(received.some((m) => m.includes('tts.sentence'))).toBe(true);

      await waitFor(() => received.some((m) => m.includes('agent.done')));
      expect(received.some((m) => m.includes('tts.end'))).toBe(true);
      const audio = received.find((m) => m.includes('audio.chunk'));
      expect(audio).toContain('ZmFrZS1tcDMtYnl0ZXM='); // base64 of fake-mp3-bytes
      expect(audio).toContain('mp3');

      const sessionResponse = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}`,
      });
      const messages = sessionResponse.json().messages as Array<{ role: string; content: string }>;
      expect(messages.at(-2)?.content).toBe('现在几点？');
      expect(messages.at(-1)?.content).toBe('你好，世界');

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('executes Qwen voice tool calls through the agent loop', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'time.get',
      description: '获取当前时间',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      async execute() {
        return { ok: true, data: { text: '2026年8月19日 10:00' } };
      },
    });
    const recordedInputs: ChatInput[] = [];
    const synthesized: string[] = [];
    const llm = scriptedLLM(
      [
        async function* () {
          yield {
            delta: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'time.get', arguments: '{}' }],
          };
        },
        async function* () {
          yield { delta: '现在是' };
          yield { delta: '2026年8月19日 10:00。' };
          yield { delta: '', finishReason: 'stop' };
        },
      ],
      recordedInputs,
    );

    const fakes = new Map<string, FakeQwenClient>();
    const app = build(
      qwenConfig,
      llm,
      undefined,
      registry,
      undefined,
      undefined,
      (model) => {
        const fake = new FakeQwenClient();
        fakes.set(model, fake);
        return fake as unknown as QwenRealtimeClient;
      },
      () => recordingTTS(synthesized),
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const sessionId = await createSession(app);
      const received: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${sessionId}`);
      ws.on('message', (data) => received.push(data.toString()));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      await waitFor(() => received.some((m) => m.includes('voice.ready')));

      const asr = fakes.get(qwenConfig.qwenRealtime.asrModel);
      asr?.emitUserFinal('现在几点了？');

      await waitFor(() => received.some((m) => m.includes('agent.tool_result')));
      expect(received.some((m) => m.includes('agent.tool_call'))).toBe(true);
      // The tool result was fed back into the second LLM turn.
      expect(recordedInputs[1]?.messages.at(-1)?.role).toBe('tool');

      // The final answer is spoken through ElevenLabs TTS.
      await waitFor(() => synthesized.includes('现在是2026年8月19日 10:00。'));

      await waitFor(() => received.some((m) => m.includes('agent.done')));
      ws.close();
    } finally {
      await app.close();
    }
  });

  it('requires desktop approval for L2 tools called over Qwen voice', async () => {
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register({
      name: 'notification.send',
      description: '发送通知',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 2,
      async execute() {
        executed += 1;
        return { ok: true, data: { sent: true } };
      },
    });
    const llm = scriptedLLM([
      async function* () {
        yield {
          delta: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_2', name: 'notification.send', arguments: '{"text":"hi"}' }],
        };
      },
      async function* () {
        yield { delta: '已发送。' };
        yield { delta: '', finishReason: 'stop' };
      },
    ]);

    const fakes = new Map<string, FakeQwenClient>();
    const synthesized: string[] = [];
    const app = build(
      qwenConfig,
      llm,
      undefined,
      registry,
      undefined,
      undefined,
      (model) => {
        const fake = new FakeQwenClient();
        fakes.set(model, fake);
        return fake as unknown as QwenRealtimeClient;
      },
      () => recordingTTS(synthesized),
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const sessionId = await createSession(app);
      const received: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${sessionId}`);
      ws.on('message', (data) => received.push(data.toString()));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      await waitFor(() => received.some((m) => m.includes('voice.ready')));

      const asr = fakes.get(qwenConfig.qwenRealtime.asrModel);
      asr?.emitUserFinal('发送通知');

      // runChat raised a permission request that the route forwarded to the desktop.
      await waitFor(() => received.some((m) => m.includes('permission.request')));
      expect(executed).toBe(0);
      const request = received
        .map(
          (raw) => JSON.parse(raw) as { type: string; payload: { request: { requestId: string } } },
        )
        .find((message) => message.type === 'permission.request');
      ws.send(
        JSON.stringify({
          type: 'permission.response',
          requestId: request?.payload.request.requestId,
          approved: true,
        }),
      );

      await waitFor(() => received.some((m) => m.includes('agent.tool_result')));
      expect(executed).toBe(1);

      await waitFor(() => synthesized.includes('已发送。'));

      await waitFor(() => received.some((m) => m.includes('agent.done')));
      ws.close();
    } finally {
      await app.close();
    }
  });

  it('Qwen 级联语音每轮使用新的 requestId（"仅本次允许"不跨轮）', async () => {
    const fakes = new Map<string, FakeQwenClient>();
    const app = build(
      qwenConfig,
      fakeLLM(),
      undefined,
      undefined,
      undefined,
      undefined,
      (model) => {
        const fake = new FakeQwenClient();
        fakes.set(model, fake);
        return fake as unknown as QwenRealtimeClient;
      },
      () => recordingTTS([]),
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const sessionId = await createSession(app);
      const received: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${sessionId}`);
      ws.on('message', (data) => received.push(data.toString()));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      await waitFor(() => received.some((m) => m.includes('voice.ready')));
      const asr = fakes.get(qwenConfig.qwenRealtime.asrModel);

      const doneRequestIds = (): string[] =>
        received
          .map((raw) => JSON.parse(raw) as { type: string; requestId?: string })
          .filter((message) => message.type === 'chat.done')
          .map((message) => message.requestId ?? '');

      asr?.emitUserFinal('第一句');
      await waitFor(() => doneRequestIds().length === 1);
      asr?.emitUserFinal('第二句');
      await waitFor(() => doneRequestIds().length === 2);

      const [first, second] = doneRequestIds();
      expect(first).toBeTruthy();
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('Qwen 级联语音打断：部分回复先落库，再写下一轮用户消息', async () => {
    const store = new DelayedWriteSessionStore((input) =>
      input.role === 'assistant' && input.content === '好的。' ? 150 : 0,
    );
    const fakes = new Map<string, FakeQwenClient>();
    const app = build(
      qwenConfig,
      abortAwareLLM('好的。'),
      undefined,
      undefined,
      undefined,
      undefined,
      (model) => {
        const fake = new FakeQwenClient();
        fakes.set(model, fake);
        return fake as unknown as QwenRealtimeClient;
      },
      () => recordingTTS([]),
      store,
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const session = await store.createSession({ systemPrompt: '测试' });
      const received: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${session.id}`);
      ws.on('message', (data) => received.push(data.toString()));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      await waitFor(() => received.some((m) => m.includes('voice.ready')));
      const asr = fakes.get(qwenConfig.qwenRealtime.asrModel);

      asr?.emitUserFinal('第一句');
      await waitFor(() => received.some((m) => m.includes('tts.sentence')));
      // 打断并立刻开始下一轮
      asr?.emitUserFinal('第二句');
      await waitFor(async () =>
        (await store.getSession(session.id)).messages.some((m) => m.content === '第二句'),
      );
      // 给未串行化的写入留出落库时间（修复前它会排在第二句之后）
      await new Promise((resolve) => setTimeout(resolve, 250));

      const roles = (await store.getSession(session.id)).messages.map((m) => m.role);
      const lastUser = roles.lastIndexOf('user');
      expect(roles.slice(lastUser).every((role) => role === 'user')).toBe(true);

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('routes voice over WebSocket through Qwen S2S (PCM bridge)', async () => {
    const fake = new FakeQwenClient();
    const app = build(
      s2sConfig,
      fakeLLM(),
      undefined,
      undefined,
      undefined,
      undefined,
      () => fake as unknown as QwenRealtimeClient,
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {},
      });
      const sessionId = created.json().id as string;

      const received: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${sessionId}`);
      ws.on('message', (data) => received.push(data.toString()));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });

      await waitFor(() => received.some((m) => m.includes('voice.ready')));
      expect(fake.sessionUpdate).toBeDefined();
      const session = fake.sessionUpdate as {
        voice: string;
        turn_detection: { type: string };
        tools: Array<{ function: { name: string } }>;
      };
      expect(session.voice).toBe('longanqian');
      expect(session.turn_detection.type).toBe('smart_turn');
      expect(Array.isArray(session.tools)).toBe(true);

      // User turn: partial -> final, then the model streams a reply.
      ws.send(Buffer.from('pcm-audio-bytes'));
      await waitFor(() => fake.sent.some((entry) => entry.startsWith('audio:')));
      fake.emitUserFinal('现在几点？');
      await waitFor(() => received.some((m) => m.includes('transcript.final')));

      fake.emitResponseCreated();
      fake.emitAssistant('现在是');
      fake.emitAudio(Buffer.from([0x11, 0x22]).toString('base64'));
      fake.emitResponseDone('completed', '现在是下午三点。');

      await waitFor(() => received.some((m) => m.includes('agent.done')));
      expect(received.some((m) => m.includes('agent.thinking'))).toBe(true);
      expect(received.some((m) => m.includes('tts.end'))).toBe(true);
      const audio = received.find((m) => m.includes('audio.chunk'));
      expect(audio).toContain('pcm');
      expect(audio).toContain('24000');

      const sessionResponse = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}`,
      });
      const messages = sessionResponse.json().messages as Array<{ role: string; content: string }>;
      expect(messages.at(-2)?.content).toBe('现在几点？');
      expect(messages.at(-1)?.content).toBe('现在是下午三点。');

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('executes S2S function calls through the tool registry', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'time.get',
      description: '获取当前时间',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      async execute() {
        return { ok: true, data: { text: '2026年8月19日 10:00' } };
      },
    });

    const fake = new FakeQwenClient();
    const app = build(
      s2sConfig,
      fakeLLM(),
      undefined,
      registry,
      undefined,
      undefined,
      () => fake as unknown as QwenRealtimeClient,
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const sessionId = await createSession(app);
      const received: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${sessionId}`);
      ws.on('message', (data) => received.push(data.toString()));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      await waitFor(() => received.some((m) => m.includes('voice.ready')));

      fake.emitFunctionCall('call_1', 'time.get', '{"tz":"Asia/Shanghai"}');

      await waitFor(() => received.some((m) => m.includes('agent.tool_result')));
      expect(received.some((m) => m.includes('agent.tool_call'))).toBe(true);
      const output = fake.sent.find((entry) => entry.startsWith('output:call_1:'));
      expect(output).toContain('2026年8月19日 10:00');
      expect(fake.sent).toContain('response.create');

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('requires desktop approval for L2 tools called over S2S voice', async () => {
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register({
      name: 'notification.send',
      description: '发送通知',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 2,
      async execute() {
        executed += 1;
        return { ok: true, data: { sent: true } };
      },
    });

    const fake = new FakeQwenClient();
    const app = build(
      s2sConfig,
      fakeLLM(),
      undefined,
      registry,
      undefined,
      undefined,
      () => fake as unknown as QwenRealtimeClient,
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const sessionId = await createSession(app);
      const received: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${sessionId}`);
      ws.on('message', (data) => received.push(data.toString()));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      await waitFor(() => received.some((m) => m.includes('voice.ready')));

      fake.emitFunctionCall('call_2', 'notification.send', '{"text":"hi"}');
      await waitFor(() => received.some((m) => m.includes('permission.request')));
      expect(executed).toBe(0);

      const request = received
        .map(
          (raw) => JSON.parse(raw) as { type: string; payload: { request: { requestId: string } } },
        )
        .find((message) => message.type === 'permission.request');
      ws.send(
        JSON.stringify({
          type: 'permission.response',
          requestId: request?.payload.request.requestId,
          approved: true,
        }),
      );

      await waitFor(() => received.some((m) => m.includes('agent.tool_result')));
      expect(executed).toBe(1);
      expect(fake.sent.some((entry) => entry.startsWith('output:call_2:'))).toBe(true);

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('S2S 语音的"仅本次允许"不跨轮生效（每轮新 requestId）', async () => {
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register({
      name: 'notification.send',
      description: '发送通知',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 2,
      async execute() {
        executed += 1;
        return { ok: true, data: { sent: true } };
      },
    });

    const fake = new FakeQwenClient();
    const app = build(
      s2sConfig,
      fakeLLM(),
      undefined,
      registry,
      undefined,
      undefined,
      () => fake as unknown as QwenRealtimeClient,
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const sessionId = await createSession(app);
      const received: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${sessionId}`);
      ws.on('message', (data) => received.push(data.toString()));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      await waitFor(() => received.some((m) => m.includes('voice.ready')));

      const approveNext = async (): Promise<void> => {
        await waitFor(() => received.some((m) => m.includes('permission.request')));
        const request = received
          .map(
            (raw) =>
              JSON.parse(raw) as { type: string; payload: { request: { requestId: string } } },
          )
          .filter((message) => message.type === 'permission.request')
          .at(-1);
        ws.send(
          JSON.stringify({
            type: 'permission.response',
            requestId: request?.payload.request.requestId,
            approved: true,
          }),
        );
      };

      // 第 1 轮：批准一次（参数 A）
      fake.emitFunctionCall('call_a', 'notification.send', '{"text":"first"}');
      await approveNext();
      await waitFor(() => executed === 1);
      // 轮次结束：工具结果回喂后模型给出最终回复（真实流程里会先 response.created）
      fake.emitResponseCreated();
      fake.emitResponseDone('completed', '已发送。');
      await waitFor(() => received.some((m) => m.includes('agent.done')));

      // 第 2 轮：不同参数 —— 必须重新征求同意，不能沿用上一轮的"仅本次允许"
      received.length = 0;
      fake.emitFunctionCall('call_b', 'notification.send', '{"text":"second"}');
      await waitFor(() => received.some((m) => m.includes('permission.request')));
      expect(executed).toBe(1);

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('S2S 打断时先落库部分回复，再写入下一轮用户消息（顺序不错乱）', async () => {
    const store = new DelayedWriteSessionStore((input) =>
      input.role === 'assistant' ? 80 : 0,
    );
    const fake = new FakeQwenClient();
    const app = build(
      s2sConfig,
      fakeLLM(),
      undefined,
      undefined,
      undefined,
      undefined,
      () => fake as unknown as QwenRealtimeClient,
      undefined,
      store,
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const session = await store.createSession({ systemPrompt: '测试' });
      const received: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${session.id}`);
      ws.on('message', (data) => received.push(data.toString()));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      await waitFor(() => received.some((m) => m.includes('voice.ready')));

      // 打断：部分助手回复入库（写入慢）；紧接着用户说下一句（写入快）
      fake.emitResponseDone('cancelled', '我正在说……');
      fake.emitUserFinal('等一下');

      await waitFor(async () => (await store.getSession(session.id)).messages.length === 2);
      const messages = (await store.getSession(session.id)).messages;
      expect(messages[0]?.role).toBe('assistant');
      expect(messages[0]?.content).toBe('我正在说……');
      expect(messages[1]?.role).toBe('user');

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('keeps the S2S turn open while a tool call is pending', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'time.get',
      description: '获取当前时间',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      async execute() {
        return { ok: true, data: { text: '2026年8月19日 10:00' } };
      },
    });

    const fake = new FakeQwenClient();
    const app = build(
      s2sConfig,
      fakeLLM(),
      undefined,
      registry,
      undefined,
      undefined,
      () => fake as unknown as QwenRealtimeClient,
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const sessionId = await createSession(app);
      const received: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${sessionId}`);
      ws.on('message', (data) => received.push(data.toString()));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      await waitFor(() => received.some((m) => m.includes('voice.ready')));

      // The model emits a function call; the tool runs and returns.
      fake.emitFunctionCall('call_1', 'time.get', '{}', 'resp_1');
      await waitFor(() => received.some((m) => m.includes('agent.tool_result')));
      // The first response's done can arrive late (after the tool already
      // ran); it must still not end the turn.
      fake.emitResponseDone('completed', '', 'resp_1');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received.some((m) => m.includes('tts.end'))).toBe(false);
      expect(received.some((m) => m.includes('agent.done'))).toBe(false);

      // The follow-up response finishes the turn.
      fake.emitResponseCreated();
      fake.emitAssistant('现在是');
      fake.emitResponseDone('completed', '现在是2026年8月19日 10:00。', 'resp_2');
      await waitFor(() => received.some((m) => m.includes('agent.done')));
      expect(received.some((m) => m.includes('tts.end'))).toBe(true);

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('runs the agent loop: tool call -> tool result -> final answer', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'time.get',
      description: '获取当前时间',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      async execute() {
        return { ok: true, data: { text: '2026年8月19日 10:00' } };
      },
    });

    const recordedInputs: ChatInput[] = [];
    const llm = scriptedLLM(
      [
        async function* () {
          yield {
            delta: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'time.get', arguments: '{}' }],
          };
        },
        async function* () {
          yield { delta: '现在是' };
          yield { delta: '2026年8月19日 10:00。' };
          yield {
            delta: '',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
          };
        },
      ],
      recordedInputs,
    );

    const app = build(testConfig, llm, undefined, registry);
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {},
    });
    const sessionId = createResponse.json().id as string;

    const chatResponse = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/chat`,
      payload: { message: '现在几点了？' },
    });
    expect(chatResponse.statusCode).toBe(200);

    const events = parseSse(chatResponse.body);
    const types = events.map((event) => event.type);
    expect(types).toContain('agent.tool_call');
    expect(types).toContain('agent.tool_result');
    expect(types).toContain('chat.token');
    expect(types).toContain('chat.done');

    const text = events
      .filter((event) => event.type === 'chat.token')
      .map((event) => (event.payload as { delta: string }).delta)
      .join('');
    expect(text).toBe('现在是2026年8月19日 10:00。');

    // The tool result is fed back into the second LLM turn.
    const secondTurn = recordedInputs[1];
    expect(secondTurn?.messages.at(-1)?.role).toBe('tool');
    expect(secondTurn?.messages.at(-1)?.tool_call_id).toBe('call_1');
    expect(secondTurn?.messages.at(-1)?.content).toContain('2026年8月19日 10:00');
    // 工具名回传时按 OpenAI 兼容 API 规则下划线化（time.get -> time_get），
    // 执行时再在会话服务里还原为真实名。
    const assistantToolMsg = secondTurn?.messages.find((m) => m.role === 'assistant');
    expect(assistantToolMsg?.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'time_get', arguments: '{}' } },
    ]);

    // Conversation history records every stage.
    const sessionResponse = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}`,
    });
    const messages = sessionResponse.json().messages as Array<{
      role: string;
      toolCalls?: unknown[];
      toolCallId?: string;
    }>;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(messages[1]?.toolCalls).toBeDefined();
    expect(messages[2]?.toolCallId).toBe('call_1');
  });

  it('feeds unknown-tool errors back to the LLM and keeps looping', async () => {
    const recordedInputs: ChatInput[] = [];
    const llm = scriptedLLM(
      [
        async function* () {
          yield {
            delta: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_x', name: 'no.such.tool', arguments: '{}' }],
          };
        },
        async function* () {
          yield { delta: '我无法使用该工具。' };
          yield { delta: '', finishReason: 'stop' };
        },
      ],
      recordedInputs,
    );

    const app = build(testConfig, llm, undefined, new ToolRegistry());
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {},
    });
    const sessionId = createResponse.json().id as string;

    const chatResponse = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/chat`,
      payload: { message: '调用不存在的工具' },
    });
    const events = parseSse(chatResponse.body);
    const toolResult = events.find((event) => event.type === 'agent.tool_result');
    const result = (toolResult?.payload as { result: { ok: boolean; error?: string } }).result;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Tool not found');

    const secondTurn = recordedInputs[1];
    expect(secondTurn?.messages.at(-1)?.content).toContain('Tool not found');
  });

  it('requires user approval for L2 tools and honors rejection', async () => {
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register({
      name: 'notification.send',
      description: '发送通知',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 2,
      async execute() {
        executed += 1;
        return { ok: true, data: { sent: true } };
      },
    });

    const recordedInputs: ChatInput[] = [];
    const llm = scriptedLLM(
      [
        async function* () {
          yield {
            delta: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_n', name: 'notification.send', arguments: '{"text":"hi"}' }],
          };
        },
        async function* () {
          yield { delta: '好的，已取消发送。' };
          yield { delta: '', finishReason: 'stop' };
        },
      ],
      recordedInputs,
    );

    const app = build(testConfig, llm, undefined, registry);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const sessionId = await createSession(app);
      const events = await streamChatAndResolve(
        `http://127.0.0.1:${port}/api/sessions/${sessionId}/chat`,
        '发送一条通知',
        async (event) => {
          if (event.type === 'permission.request') {
            const request = (event.payload as { request: { requestId: string } }).request;
            await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/permission`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ requestId: request.requestId, approved: false }),
            });
          }
        },
      );

      const types = events.map((event) => event.type);
      expect(types).toContain('permission.request');
      expect(types).toContain('permission.response');
      const response = events.find((event) => event.type === 'permission.response');
      expect((response?.payload as { approved: boolean }).approved).toBe(false);
      const toolResult = events.find((event) => event.type === 'agent.tool_result');
      expect((toolResult?.payload as { result: { error: string } }).result.error).toContain(
        '未获批准',
      );
      expect(executed).toBe(0);
      // The denial is fed back to the LLM.
      const secondTurn = recordedInputs[1];
      expect(secondTurn?.messages.at(-1)?.content).toContain('未获批准');
    } finally {
      await app.close();
    }
  });

  it('executes L2 tools after user approval', async () => {
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register({
      name: 'notification.send',
      description: '发送通知',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 2,
      async execute() {
        executed += 1;
        return { ok: true, data: { sent: true } };
      },
    });
    const llm = scriptedLLM([
      async function* () {
        yield {
          delta: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_n', name: 'notification.send', arguments: '{"text":"hi"}' }],
        };
      },
      async function* () {
        yield { delta: '已发送。' };
        yield { delta: '', finishReason: 'stop' };
      },
    ]);

    const app = build(testConfig, llm, undefined, registry);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const sessionId = await createSession(app);
      await streamChatAndResolve(
        `http://127.0.0.1:${port}/api/sessions/${sessionId}/chat`,
        '发送通知',
        async (event) => {
          if (event.type === 'permission.request') {
            const request = (event.payload as { request: { requestId: string } }).request;
            await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/permission`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ requestId: request.requestId, approved: true }),
            });
          }
        },
      );
      expect(executed).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('rejects tool calls with invalid arguments before execution', async () => {
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register({
      name: 'echo.text',
      description: '回声',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      permissionLevel: 0,
      async execute() {
        executed += 1;
        return { ok: true, data: { text: 'ok' } };
      },
    });
    const recordedInputs: ChatInput[] = [];
    const llm = scriptedLLM(
      [
        async function* () {
          yield {
            delta: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_bad', name: 'echo.text', arguments: '{"text":123}' }],
          };
        },
        async function* () {
          yield { delta: '参数不对，我重新来。' };
          yield { delta: '', finishReason: 'stop' };
        },
      ],
      recordedInputs,
    );

    const app = build(testConfig, llm, undefined, registry);
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {},
    });
    const sessionId = createResponse.json().id as string;

    const chatResponse = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/chat`,
      payload: { message: '回声' },
    });
    const events = parseSse(chatResponse.body);
    const toolResult = events.find((event) => event.type === 'agent.tool_result');
    const result = (toolResult?.payload as { result: { ok: boolean; error: string } }).result;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('参数校验失败');
    expect(executed).toBe(0);
    // The validation error is fed back so the LLM can retry with valid args.
    const secondTurn = recordedInputs[1];
    expect(secondTurn?.messages.at(-1)?.content).toContain('参数校验失败');
  });

  it('honors a tool-level timeoutMs in the agent loop', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'hang.tool',
      description: '永不返回',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      timeoutMs: 200,
      async execute() {
        // Never settles and ignores the abort signal: only the race can cut it.
        await new Promise(() => {});
        return { ok: true, data: {} };
      },
    });
    const llm = scriptedLLM([
      async function* () {
        yield {
          delta: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_h', name: 'hang.tool', arguments: '{}' }],
        };
      },
      async function* () {
        yield { delta: '工具超时了，我换个方式。' };
        yield { delta: '', finishReason: 'stop' };
      },
    ]);

    const app = build(testConfig, llm, undefined, registry);
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {},
    });
    const sessionId = createResponse.json().id as string;

    const chatResponse = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/chat`,
      payload: { message: '挂起' },
    });
    expect(chatResponse.statusCode).toBe(200);
    const events = parseSse(chatResponse.body);
    const toolResult = events.find((event) => event.type === 'agent.tool_result');
    const result = (toolResult?.payload as { result: { ok: boolean; error: string } }).result;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('超时');
  });

  it('auto-runs an L2 tool with identical arguments after first approval', async () => {
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register({
      name: 'process.kill',
      description: '结束进程',
      inputSchema: {
        type: 'object',
        properties: { pid: { type: 'number' } },
        required: ['pid'],
      },
      permissionLevel: 2,
      async execute() {
        executed += 1;
        return { ok: true, data: { killed: true } };
      },
    });
    const llm = scriptedLLM([
      async function* () {
        yield {
          delta: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_k1', name: 'process.kill', arguments: '{"pid":1234}' }],
        };
      },
      async function* () {
        yield { delta: '已结束。' };
        yield { delta: '', finishReason: 'stop' };
      },
      async function* () {
        yield {
          delta: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_k2', name: 'process.kill', arguments: '{"pid":1234}' }],
        };
      },
      async function* () {
        yield { delta: '再次已结束。' };
        yield { delta: '', finishReason: 'stop' };
      },
    ]);

    const approvals = new ApprovalRegistry({ timeoutMs: 500 });
    const app = build(testConfig, llm, undefined, registry, approvals);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const sessionId = await createSession(app);
      // First call: the user approves once.
      await streamChatAndResolve(
        `http://127.0.0.1:${port}/api/sessions/${sessionId}/chat`,
        '结束进程',
        async (event) => {
          if (event.type === 'permission.request') {
            const request = (event.payload as { request: { requestId: string } }).request;
            await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/permission`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ requestId: request.requestId, approved: true }),
            });
          }
        },
      );
      expect(executed).toBe(1);

      // Second call with the same arguments: runs without re-prompting.
      const second = await streamChatAndResolve(
        `http://127.0.0.1:${port}/api/sessions/${sessionId}/chat`,
        '再结束一次',
      );
      expect(second.some((event) => event.type === 'permission.request')).toBe(false);
      expect(executed).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('requires two confirmations for L3 tools', async () => {
    const { mkdtemp, writeFile, rm, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const pathMod = await import('node:path');
    const dir = await mkdtemp(pathMod.join(tmpdir(), 'l3-test-'));
    const target = pathMod.join(dir, 'secret.txt');
    await writeFile(target, 'content', 'utf8');

    const registry = new ToolRegistry();
    registry.register({
      name: 'filesystem.delete',
      description: '删除文件',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 3,
      async execute() {
        await rm(target, { force: true });
        return { ok: true, data: { deleted: true } };
      },
    });

    const llm = scriptedLLM([
      async function* () {
        yield {
          delta: '',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'call_d', name: 'filesystem.delete', arguments: '{"path":"secret.txt"}' },
          ],
        };
      },
      async function* () {
        yield { delta: '文件已删除。' };
        yield { delta: '', finishReason: 'stop' };
      },
    ]);

    const app = build(testConfig, llm, undefined, registry);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const sessionId = await createSession(app);
      const requestIds: string[] = [];
      const events = await streamChatAndResolve(
        `http://127.0.0.1:${port}/api/sessions/${sessionId}/chat`,
        '删除文件',
        async (event) => {
          if (event.type === 'permission.request') {
            const request = (event.payload as { request: { requestId: string } }).request;
            requestIds.push(request.requestId);
            await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/permission`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ requestId: request.requestId, approved: true }),
            });
          }
        },
      );

      // Two separate permission requests were raised and both approved.
      expect(requestIds).toHaveLength(2);
      expect(new Set(requestIds).size).toBe(2);
      const requests = events.filter((event) => event.type === 'permission.request');
      expect(
        (requests[0]?.payload as { request: { confirmationsDone: number } }).request
          .confirmationsDone,
      ).toBe(0);
      expect(
        (requests[1]?.payload as { request: { confirmationsDone: number } }).request
          .confirmationsDone,
      ).toBe(1);
      await expect(readFile(target, 'utf8')).rejects.toThrow();
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('auto-denies permission requests on timeout', async () => {
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register({
      name: 'notification.send',
      description: '发送通知',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 2,
      async execute() {
        executed += 1;
        return { ok: true, data: { sent: true } };
      },
    });
    const approvals = new ApprovalRegistry({ timeoutMs: 200 });
    const llm = scriptedLLM([
      async function* () {
        yield {
          delta: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_n', name: 'notification.send', arguments: '{"text":"hi"}' }],
        };
      },
      async function* () {
        yield { delta: '确认超时，已取消。' };
        yield { delta: '', finishReason: 'stop' };
      },
    ]);

    const app = build(testConfig, llm, undefined, registry, approvals);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    try {
      const sessionId = await createSession(app);
      const events = await streamChatAndResolve(
        `http://127.0.0.1:${port}/api/sessions/${sessionId}/chat`,
        '发送通知',
      );
      const response = events.find((event) => event.type === 'permission.response');
      expect((response?.payload as { approved: boolean; reason: string }).approved).toBe(false);
      expect((response?.payload as { reason: string }).reason).toBe('timeout');
      expect(executed).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('injects relevant long-term memories into the LLM context', async () => {
    const memory = new InMemoryMemoryStore();
    await memory.add({ kind: 'semantic', content: '用户喜欢喝美式咖啡' });
    const recordedInputs: ChatInput[] = [];
    const llm = scriptedLLM(
      [
        async function* () {
          yield { delta: '根据你的偏好，来杯美式。' };
          yield { delta: '', finishReason: 'stop' };
        },
      ],
      recordedInputs,
    );

    const app = build(testConfig, llm, undefined, new ToolRegistry(), undefined, memory);
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {},
    });
    const sessionId = createResponse.json().id as string;

    const chatResponse = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/chat`,
      payload: { message: '我该点什么咖啡？' },
    });
    expect(chatResponse.statusCode).toBe(200);

    const firstTurn = recordedInputs[0];
    const systemMessages = firstTurn?.messages.filter((m) => m.role === 'system');
    expect(systemMessages?.some((m) => m.content.includes('美式咖啡'))).toBe(true);
  });
});

describe('API 共享 token 鉴权（N-P0-1）', () => {
  const tokenConfig = loadConfig(
    {
      NODE_ENV: 'test',
      PORT: '3001',
      LOG_LEVEL: 'silent',
      AGENT_API_TOKEN: 'tok-secret',
    },
    { loadDotenv: false },
  );

  it('配置了 token：非豁免 API 缺 token 一律 401', async () => {
    const app = build(tokenConfig);
    for (const url of ['/api/sessions', '/api/sessions/abc/chat', '/api/sessions/abc/permission']) {
      const response = await app.inject({ method: 'POST', url, payload: {} });
      expect(response.statusCode, url).toBe(401);
    }
    const get = await app.inject({ method: 'GET', url: '/api/sessions/abc' });
    expect(get.statusCode).toBe(401);
  });

  it('Authorization: Bearer 与 x-agent-token 两种头都放行', async () => {
    const app = build(tokenConfig);
    const bearer = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { authorization: 'Bearer tok-secret' },
      payload: {},
    });
    expect(bearer.statusCode).toBe(201);

    const headerToken = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'x-agent-token': 'tok-secret' },
      payload: {},
    });
    expect(headerToken.statusCode).toBe(201);

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'x-agent-token': 'tok-wrong' },
      payload: {},
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('/health、/xiaohei、/xiaoyou、/xiaomei、/api/hooks/:name 保持免 token（探活、静态页、hooks 自带 HOOK_SECRET）', async () => {
    const hooks = {
      async handle() {},
    } as unknown as HookService;
    const app = buildApp({
      config: tokenConfig,
      store: new InMemorySessionStore(),
      llm: fakeLLM(),
      persona: stubPersona,
      tools: new ToolRegistry(),
      approvals: new ApprovalRegistry({ timeoutMs: 5000 }),
      memory: new InMemoryMemoryStore(),
      createVoice: () => ({ stt: makeStubSTT(), tts: stubTTS }),
      hooks,
      hookSecret: 'hook-secret',
    });

    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/xiaohei' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/xiaoyou' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/xiaomei' })).statusCode).toBe(200);
    // hooks 端点不被 API token 拦截，但仍由 HOOK_SECRET 把关
    const noSecret = await app.inject({ method: 'POST', url: '/api/hooks/github', payload: {} });
    expect(noSecret.statusCode).toBe(401);
    expect(noSecret.json().error).toContain('x-hook-secret');
    const withSecret = await app.inject({
      method: 'POST',
      url: '/api/hooks/github',
      headers: { 'x-hook-secret': 'hook-secret' },
      payload: {},
    });
    expect(withSecret.statusCode).toBe(200);
  });

  it('语音 WebSocket 升级同样要 token（缺 token 直接 401，不建立连接）', async () => {
    const app = build(tokenConfig);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    try {
      const sessionId = await createSession(app, 'tok-secret');
      const denied = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${sessionId}`);
      // WS 无法在 HTTP 层拒绝升级（fastify-websocket 限制）：握手成功后
      // handler 内鉴权失败会立即 socket.close(1008)，未鉴权连接无法正常使用。
      const outcome = await new Promise<{ opened: boolean; code?: number }>((resolve) => {
        denied.once('error', () => resolve({ opened: false }));
        denied.once('close', (code) => resolve({ opened: false, code }));
        denied.once('open', () => {
          denied.once('close', (code) => resolve({ opened: true, code }));
        });
      });
      // 握手成功但立即被服务器关闭（code 1008），或握手前失败——都算"未鉴权被拒"
      expect(outcome.opened === false || outcome.code === 1008).toBe(true);

      const allowed = new WebSocket(`ws://127.0.0.1:${port}/ws/voice/${sessionId}`, {
        headers: { 'x-agent-token': 'tok-secret' },
      });
      await new Promise<void>((resolve, reject) => {
        allowed.once('open', () => resolve());
        allowed.once('error', reject);
      });
      allowed.close();
    } finally {
      await app.close();
    }
  });

  it('生产环境未配置 token：非豁免 API 一律拒绝（fail closed），探活仍可用', async () => {
    const prodConfig = loadConfig(
      { NODE_ENV: 'production', PORT: '3001', LOG_LEVEL: 'silent' },
      { loadDotenv: false },
    );
    const app = build(prodConfig);
    const denied = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error).toContain('AGENT_API_TOKEN');
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('开发/测试未配置 token：保持放行（不误伤本地开发）', async () => {
    const response = await build(testConfig).inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {},
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('审批归属校验（N-P0-3）', () => {
  it('拿别的会话的 requestId 作答返回 403，未知 requestId 仍是 404', async () => {
    const approvals = new ApprovalRegistry({ timeoutMs: 30_000 });
    const app = build(testConfig, fakeLLM(), undefined, new ToolRegistry(), approvals);
    const ownerSession = await createSession(app);
    const otherSession = await createSession(app);
    const { request } = approvals.request({
      sessionId: ownerSession,
      toolName: 'files.delete',
      arguments: { path: '/tmp/x' },
      permissionLevel: 2,
      confirmationsNeeded: 1,
    });

    const foreign = await app.inject({
      method: 'POST',
      url: `/api/sessions/${otherSession}/permission`,
      payload: { requestId: request.requestId, approved: true },
    });
    expect(foreign.statusCode).toBe(403);

    const unknown = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ownerSession}/permission`,
      payload: { requestId: 'no-such-request', approved: true },
    });
    expect(unknown.statusCode).toBe(404);

    const owner = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ownerSession}/permission`,
      payload: { requestId: request.requestId, approved: true },
    });
    expect(owner.statusCode).toBe(200);
    approvals.clearForSession(ownerSession);
  });
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createSession(app: FastifyInstance, token?: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    ...(token ? { headers: { 'x-agent-token': token } } : {}),
    payload: {},
  });
  return (response.json() as { id: string }).id;
}

interface StreamedEvent {
  type: string;
  payload: unknown;
}

/**
 * Streams an SSE chat response, invoking `onEvent` as events arrive (used to
 * answer permission requests mid-stream), and returns all events.
 */
async function streamChatAndResolve(
  url: string,
  message: string,
  onEvent?: (event: StreamedEvent) => Promise<void> | void,
  timeoutMs = 15000,
): Promise<StreamedEvent[]> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`chat failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: StreamedEvent[] = [];
  const startedAt = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index: number;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 2);
      if (!block.startsWith('data: ')) continue;
      const event = JSON.parse(block.slice(6)) as StreamedEvent;
      events.push(event);
      if (onEvent) await onEvent(event);
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('stream chat timed out');
      }
    }
  }
  return events;
}
