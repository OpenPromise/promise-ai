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

  it('DATABASE_URL 非法时回退为 undefined（不启动失败）；合法时保留', () => {
    const invalid = loadConfig(
      { ...baseEnv, DATABASE_URL: 'not a url' },
      { loadDotenv: false },
    );
    expect(invalid.databaseUrl).toBeUndefined();

    const valid = loadConfig(
      { ...baseEnv, DATABASE_URL: 'postgres://user:pass@host:5432/db' },
      { loadDotenv: false },
    );
    expect(valid.databaseUrl).toBe('postgres://user:pass@host:5432/db');
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

  it('读取 API 共享 token（agent-server 校验用）与 bridge token（调用微信桥用）', () => {
    const config = loadConfig(
      { ...baseEnv, AGENT_API_TOKEN: '  tok-agent  ', BRIDGE_TOKEN: 'tok-bridge' },
      { loadDotenv: false },
    );
    expect(config.agentApiToken).toBe('tok-agent');
    expect(config.bridgeToken).toBe('tok-bridge');
  });

  it('token 未配置/空串时为 undefined（由调用方决定拒绝还是放行）', () => {
    const config = loadConfig({ ...baseEnv, AGENT_API_TOKEN: '', BRIDGE_TOKEN: '  ' }, {
      loadDotenv: false,
    });
    expect(config.agentApiToken).toBeUndefined();
    expect(config.bridgeToken).toBeUndefined();
  });

  it('throws ConfigError on invalid values', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: 'not-a-number' }, { loadDotenv: false })).toThrow(
      ConfigError,
    );
  });

  it('supports deepseek as the LLM provider and toggles voice', () => {
    const config = loadConfig(
      {
        ...baseEnv,
        LLM_PROVIDER: 'deepseek',
        DEEPSEEK_API_KEY: 'sk-deepseek-test',
        DEEPSEEK_LLM_MODEL: 'deepseek-v4-flash',
        VOICE_ENABLED: 'false',
      },
      { loadDotenv: false },
    );
    expect(config.llmProvider).toBe('deepseek');
    expect(config.deepseek.configured).toBe(true);
    expect(config.deepseek.model).toBe('deepseek-v4-flash');
    expect(config.deepseek.baseUrl).toBe('https://api.deepseek.com');
    expect(config.voiceEnabled).toBe(false);
  });
});
