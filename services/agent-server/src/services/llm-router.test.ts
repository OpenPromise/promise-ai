import { describe, expect, it, vi } from 'vitest';
import type { ChatChunk, ChatInput, LLMProvider } from '@personal-ai/llm';
import { createRoutedLLMProvider, isComplexRequest } from './llm-router.js';

function makeProvider(name: string, tag: string): LLMProvider {
  return {
    name,
    model: tag,
    configured: true,
    async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
      yield { delta: `${tag}:${input.messages.at(-1)?.content}` };
    },
    async generate(input: ChatInput) {
      return { text: `${tag}:${input.messages.at(-1)?.content}` };
    },
  };
}

function inputOf(message: string): ChatInput {
  return {
    messages: [
      { role: 'system', content: '你是助理。' },
      { role: 'user', content: message },
    ],
  };
}

describe('isComplexRequest（90/10 路由启发式）', () => {
  it('日常闲聊走快模型', () => {
    expect(isComplexRequest(inputOf('今天天气怎么样'))).toBe(false);
    expect(isComplexRequest(inputOf('哈哈哈哈'))).toBe(false);
  });

  it('开发/分析/排查类关键词触发 pro', () => {
    for (const message of [
      '帮我开发一个新功能',
      '分析一下这个项目的架构',
      '排查一下服务器为什么这么慢',
      '重构一下这段代码',
      '这个 bug 怎么修',
      '帮我写一个 md5 工具',
      '优化一下性能',
    ]) {
      expect(isComplexRequest(inputOf(message)), message).toBe(true);
    }
  });

  it('长消息直接视为复杂任务', () => {
    const long = '请详细评估' + '很长的需求描述'.repeat(60);
    expect(long.length).toBeGreaterThan(300);
    expect(isComplexRequest(inputOf(long))).toBe(true);
  });
});

describe('createRoutedLLMProvider', () => {
  it('按复杂度路由 chat 流', async () => {
    const fast = makeProvider('fast', 'F');
    const smart = makeProvider('smart', 'P');
    const routed = createRoutedLLMProvider({ fast, smart });

    const simple: string[] = [];
    for await (const chunk of routed.chat(inputOf('你好呀'))) simple.push(chunk.delta);
    expect(simple.join('')).toBe('F:你好呀');

    const complex: string[] = [];
    for await (const chunk of routed.chat(inputOf('帮我重构这个项目'))) complex.push(chunk.delta);
    expect(complex.join('')).toBe('P:帮我重构这个项目');
  });

  it('generate 同样按复杂度路由', async () => {
    const fast = makeProvider('fast', 'F');
    const smart = makeProvider('smart', 'P');
    const routed = createRoutedLLMProvider({ fast, smart });
    expect((await routed.generate(inputOf('随便聊聊'))).text).toBe('F:随便聊聊');
    expect((await routed.generate(inputOf('设计一个方案'))).text).toBe('P:设计一个方案');
  });

  it('支持自定义分类器与路由日志', async () => {
    const fast = makeProvider('fast', 'F');
    const smart = makeProvider('smart', 'P');
    const onRoute = vi.fn();
    const routed = createRoutedLLMProvider({
      fast,
      smart,
      classify: (input) => input.messages.at(-1)?.content?.includes('重要') ?? false,
      onRoute,
    });
    await routed.generate(inputOf('这是一件重要的事'));
    expect(onRoute).toHaveBeenCalledWith(expect.anything(), 'smart');
  });
});
