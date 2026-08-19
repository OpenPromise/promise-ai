import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './index.js';

const baseEnv = {
  NODE_ENV: 'test',
  PORT: '3001',
  LOG_LEVEL: 'silent',
};

describe('config', () => {
  it('applies defaults and does not require third-party keys', () => {
    const config = loadConfig(baseEnv, { loadDotenv: false });
    expect(config.nodeEnv).toBe('test');
    expect(config.port).toBe(3001);
    expect(config.llmProvider).toBe('dashscope');
    expect(config.dashscope.configured).toBe(false);
  });

  it('supports openrouter as the LLM provider', () => {
    const config = loadConfig(
      {
        ...baseEnv,
        LLM_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'sk-or-test',
        OPENROUTER_MODEL: 'x-ai/grok-4.6',
      },
      { loadDotenv: false },
    );
    expect(config.llmProvider).toBe('openrouter');
    expect(config.openrouter.configured).toBe(true);
    expect(config.openrouter.model).toBe('x-ai/grok-4.6');
    expect(config.openrouter.voiceModel).toBe('x-ai/grok-4.5');
    expect(config.openrouter.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('supports dashscope as the LLM provider for text reasoning', () => {
    const config = loadConfig(
      {
        ...baseEnv,
        LLM_PROVIDER: 'dashscope',
        DASHSCOPE_API_KEY: 'sk-dash-test',
        DASHSCOPE_LLM_MODEL: 'qwen3.8-max',
      },
      { loadDotenv: false },
    );
    expect(config.llmProvider).toBe('dashscope');
    expect(config.dashscope.configured).toBe(true);
    expect(config.dashscope.apiKey).toBe('sk-dash-test');
    expect(config.dashscope.model).toBe('qwen3.8-max');
    expect(config.dashscope.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
  });

  it('exposes qwen realtime voice configuration', () => {
    const config = loadConfig(
      { ...baseEnv, DASHSCOPE_API_KEY: 'sk-ws-test' },
      { loadDotenv: false },
    );
    expect(config.qwenRealtime.configured).toBe(true);
    expect(config.qwenRealtime.apiKey).toBe('sk-ws-test');
    expect(config.qwenRealtime.model).toBe('qwen-audio-3.0-realtime-plus');
    expect(config.qwenRealtime.voice).toBe('longanqian');
    expect(config.qwenRealtime.voiceMode).toBe('s2s');
    expect(config.qwenRealtime.asrModel).toBe('qwen3-asr-flash-realtime');
    expect(config.qwenRealtime.ttsModel).toBe('qwen3-tts-flash-realtime');
    expect(config.qwenRealtime.baseUrl).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/realtime');
    expect(config.qwenRealtime.ttsVoice).toBe('Cherry');
  });

  it('keeps qwen realtime unconfigured without a dashscope key', () => {
    const config = loadConfig(baseEnv, { loadDotenv: false });
    expect(config.qwenRealtime.configured).toBe(false);
    expect(config.qwenRealtime.apiKey).toBeUndefined();
  });

  it('treats empty strings as unset', () => {
    const config = loadConfig(
      { ...baseEnv, DASHSCOPE_API_KEY: '', HOME_ASSISTANT_URL: '' },
      { loadDotenv: false },
    );
    expect(config.dashscope.configured).toBe(false);
    expect(config.homeAssistant.url).toBeUndefined();
  });

  it('throws ConfigError on invalid values', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: 'not-a-number' }, { loadDotenv: false })).toThrow(
      ConfigError,
    );
  });
});
