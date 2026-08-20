import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterApiError, OpenRouterConfigError, OpenRouterProvider } from './index.js';

describe('OpenRouterProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports configured=false and default model without a key', () => {
    const provider = new OpenRouterProvider({});
    expect(provider.configured).toBe(false);
    expect(provider.model).toBe('x-ai/grok-4.6');
    expect(provider.name).toBe('openrouter');
  });

  it('throws OpenRouterConfigError on chat without a key', async () => {
    const provider = new OpenRouterProvider({});
    await expect(
      (async () => {
        for await (const _chunk of provider.chat({ messages: [] })) {
          // noop
        }
      })(),
    ).rejects.toThrow(OpenRouterConfigError);
  });

  it('streams SSE chunks and captures usage', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'));
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"，世界"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11}}\n\n',
          ),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    const fetchMock = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenRouterProvider({
      apiKey: 'sk-or-test',
      model: 'x-ai/grok-4.6',
    });
    const chunks = [];
    for await (const chunk of provider.chat({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.delta).join('')).toBe('你好，世界');
    expect(chunks.at(-1)?.usage).toEqual({
      inputTokens: 7,
      outputTokens: 4,
      totalTokens: 11,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-or-test');
    expect(headers['X-Title']).toBe('personal-ai-assistant');
  });

  it('throws OpenRouterApiError on non-2xx responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad key', { status: 401 })),
    );
    const provider = new OpenRouterProvider({ apiKey: 'sk-or-test' });
    await expect(
      (async () => {
        for await (const _chunk of provider.chat({ messages: [] })) {
          // noop
        }
      })(),
    ).rejects.toThrow(OpenRouterApiError);
  });

  it('name 选项：错误消息前缀显示真实后端（deepseek/dashscope）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('insufficient tool messages', { status: 400 })),
    );
    const deepseek = new OpenRouterProvider({
      apiKey: 'sk-ds',
      baseUrl: 'https://api.deepseek.com/v1',
      name: 'deepseek',
    });
    const error = await (async () => {
      try {
        for await (const _chunk of deepseek.chat({ messages: [] })) {
          // noop
        }
      } catch (caught) {
        return caught as Error;
      }
    })();
    expect(error?.message).toContain('deepseek API error 400');
    expect(error?.message).not.toContain('OpenRouter');

    const dashscope = new OpenRouterProvider({
      apiKey: 'sk-ds2',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      name: 'dashscope',
    });
    expect(dashscope.name).toBe('dashscope');
  });
});
