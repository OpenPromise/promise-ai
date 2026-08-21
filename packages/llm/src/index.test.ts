import { describe, expect, it } from 'vitest';
import {
  FallbackLLMProvider,
  finalizeToolCalls,
  parseSseLine,
  type GenerateResult,
  type LLMProvider,
} from './index.js';

describe('parseSseLine', () => {
  it('extracts data payloads', () => {
    expect(parseSseLine('data: hello')).toBe('hello');
    expect(parseSseLine('data: [DONE]')).toBe('[DONE]');
  });

  it('ignores non-data lines', () => {
    expect(parseSseLine('event: message')).toBeNull();
    expect(parseSseLine(': keepalive')).toBeNull();
    expect(parseSseLine('')).toBeNull();
  });
});

describe('finalizeToolCalls', () => {
  it('fills missing ids with a per-index fallback', () => {
    const calls = finalizeToolCalls([
      { index: 0, id: 'call_1', name: 'weather.get', arguments: '{}' },
      { index: 1, id: undefined, name: 'time.get', arguments: '{"tz":"Asia/Shanghai"}' },
    ]);
    expect(calls).toEqual([
      { id: 'call_1', name: 'weather.get', arguments: '{}' },
      { id: 'call_1', name: 'time.get', arguments: '{"tz":"Asia/Shanghai"}' },
    ]);
  });

  it('skips calls without a name', () => {
    const calls = finalizeToolCalls([
      { index: 0, id: 'call_1', name: undefined, arguments: '{}' },
      { index: 1, id: 'call_2', name: 'weather.get', arguments: '{}' },
    ]);
    expect(calls).toEqual([{ id: 'call_2', name: 'weather.get', arguments: '{}' }]);
  });
});

function stubProvider(
  name: string,
  behavior: {
    chatError?: Error;
    chatChunks?: string[];
    generateError?: Error;
    generateText?: string;
  },
): LLMProvider {
  return {
    name,
    model: `${name}-model`,
    configured: true,
    async *chat() {
      for (const chunk of behavior.chatChunks ?? []) {
        yield { delta: chunk };
      }
      if (behavior.chatError) throw behavior.chatError;
    },
    async generate(): Promise<GenerateResult> {
      if (behavior.generateError) throw behavior.generateError;
      return { text: behavior.generateText ?? '' };
    },
  };
}

describe('FallbackLLMProvider', () => {
  it('falls back when the primary fails before producing any chunk', async () => {
    const primary = stubProvider('primary', { chatError: new Error('boom') });
    const fallback = stubProvider('fallback', { chatChunks: ['hi'] });
    const failovers: string[] = [];
    const provider = new FallbackLLMProvider({
      primary,
      fallback,
      onFailover: (from, to) => failovers.push(`${from.name}->${to.name}`),
    });

    const chunks: string[] = [];
    for await (const chunk of provider.chat({ messages: [] })) chunks.push(chunk.delta);
    expect(chunks).toEqual(['hi']);
    expect(failovers).toEqual(['primary->fallback']);
  });

  it('does not fall back once streaming has started', async () => {
    const primary = stubProvider('primary', {
      chatChunks: ['partial '],
      chatError: new Error('mid-stream failure'),
    });
    const fallback = stubProvider('fallback', { chatChunks: ['should not appear'] });
    const provider = new FallbackLLMProvider({ primary, fallback });

    const chunks: string[] = [];
    await expect(async () => {
      for await (const chunk of provider.chat({ messages: [] })) chunks.push(chunk.delta);
    }).rejects.toThrow('mid-stream failure');
    expect(chunks).toEqual(['partial ']);
  });

  it('首个 chunk 无可见文本时仍然切换备用（实质还没输出任何内容）', async () => {
    // 常见场景：首 chunk 只带 role/usage/tool_calls（delta 为空），随后主模型限流失败
    const primary: LLMProvider = {
      name: 'primary',
      model: 'primary-model',
      configured: true,
      async *chat() {
        yield { delta: '' };
        throw new Error('rate limited');
      },
      async generate(): Promise<GenerateResult> {
        return { text: '' };
      },
    };
    const fallback = stubProvider('fallback', { chatChunks: ['备用回答'] });
    const failovers: string[] = [];
    const provider = new FallbackLLMProvider({
      primary,
      fallback,
      onFailover: (from, to) => failovers.push(`${from.name}->${to.name}`),
    });

    const chunks: string[] = [];
    for await (const chunk of provider.chat({ messages: [] })) chunks.push(chunk.delta);
    expect(chunks).toEqual(['', '备用回答']);
    expect(failovers).toEqual(['primary->fallback']);
  });

  it('消费方提前 break 时释放主流迭代器（不再悬挂 reader）', async () => {
    let released = false;
    const primary: LLMProvider = {
      name: 'primary',
      model: 'primary-model',
      configured: true,
      async *chat() {
        try {
          yield { delta: 'a' };
          yield { delta: 'b' };
        } finally {
          released = true;
        }
      },
      async generate(): Promise<GenerateResult> {
        return { text: '' };
      },
    };
    const provider = new FallbackLLMProvider({ primary });
    for await (const chunk of provider.chat({ messages: [] })) {
      expect(chunk.delta).toBe('a');
      break;
    }
    expect(released).toBe(true);
  });

  it('falls back in generate() and rethrows when no fallback is configured', async () => {
    const primary = stubProvider('primary', { generateError: new Error('down') });
    const fallback = stubProvider('fallback', { generateText: 'recovered' });
    const withFallback = new FallbackLLMProvider({ primary, fallback });
    expect((await withFallback.generate({ messages: [] })).text).toBe('recovered');

    const noFallback = new FallbackLLMProvider({ primary });
    await expect(noFallback.generate({ messages: [] })).rejects.toThrow('down');
  });

  it('reports configured only when at least one backend is ready', () => {
    const ready = stubProvider('ready', { chatChunks: ['x'] });
    const unconfigured = { ...stubProvider('unconfigured', {}), configured: false };
    expect(new FallbackLLMProvider({ primary: unconfigured }).configured).toBe(false);
    expect(new FallbackLLMProvider({ primary: unconfigured, fallback: ready }).configured).toBe(
      true,
    );
  });
});
