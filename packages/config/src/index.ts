import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
type NodeEnv = 'development' | 'test' | 'production';
export type LLMProviderName = 'openrouter' | 'dashscope' | 'deepseek';
export type LLMFallbackProviderName = 'none' | 'openrouter' | 'dashscope';

const emptyToUndefined = (value: unknown): unknown => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
};

const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());

const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());

const envSchema = z.object({
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().max(65535).default(3000)),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
  LLM_PROVIDER: z.preprocess(
    emptyToUndefined,
    z.enum(['openrouter', 'dashscope', 'deepseek']).default('dashscope'),
  ),
  DEEPSEEK_API_KEY: optionalString,
  DEEPSEEK_LLM_MODEL: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).default('deepseek-v4-flash'),
  ),
  DEEPSEEK_BASE_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().default('https://api.deepseek.com'),
  ),
  VOICE_ENABLED: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default('true')),
  LLM_FALLBACK_PROVIDER: z.preprocess(
    emptyToUndefined,
    z.enum(['none', 'openrouter', 'dashscope']).default('none'),
  ),
  LLM_FALLBACK_MODEL: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  OPENROUTER_API_KEY: optionalString,
  OPENROUTER_MODEL: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).default('x-ai/grok-4.6'),
  ),
  OPENROUTER_VOICE_MODEL: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).default('x-ai/grok-4.5'),
  ),
  OPENROUTER_BASE_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().default('https://openrouter.ai/api/v1'),
  ),
  ELEVENLABS_API_KEY: optionalString,
  ELEVENLABS_VOICE_ID: optionalString,
  ELEVENLABS_MODEL: optionalString,
  ELEVENLABS_LANGUAGE: optionalString,
  DASHSCOPE_API_KEY: optionalString,
  DASHSCOPE_LLM_MODEL: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).default('qwen3.8-max'),
  ),
  QWEN_VOICE_MODE: z.preprocess(emptyToUndefined, z.enum(['s2s', 'cascade']).default('s2s')),
  QWEN_REALTIME_MODEL: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).default('qwen-audio-3.0-realtime-plus'),
  ),
  QWEN_ASR_MODEL: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).default('qwen3-asr-flash-realtime'),
  ),
  QWEN_TTS_MODEL: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).default('qwen3-tts-flash-realtime'),
  ),
  QWEN_REALTIME_BASE_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().default('wss://dashscope.aliyuncs.com/api-ws/v1/realtime'),
  ),
  QWEN_REALTIME_VOICE: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).default('longanqian'),
  ),
  QWEN_TTS_VOICE: z.preprocess(emptyToUndefined, z.string().trim().min(1).default('Cherry')),
  DATABASE_URL: optionalString,
  HOME_ASSISTANT_URL: optionalUrl,
  HOME_ASSISTANT_TOKEN: optionalString,
});

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  logLevel: LogLevel;
  llmProvider: LLMProviderName;
  llmFallback: {
    provider: LLMFallbackProviderName;
    /** 备用模型；缺省时沿用该提供方的默认模型。 */
    model?: string;
    configured: boolean;
  };
  openrouter: {
    apiKey?: string;
    model: string;
    /** Faster model used by the voice cascade to cut first-token latency. */
    voiceModel: string;
    baseUrl: string;
    configured: boolean;
  };
  dashscope: {
    apiKey?: string;
    /** Text-reasoning model served over DashScope's OpenAI-compatible endpoint. */
    model: string;
    baseUrl: string;
    configured: boolean;
  };
  deepseek: {
    apiKey?: string;
    model: string;
    baseUrl: string;
    configured: boolean;
  };
  /** 语音（Qwen Realtime / 级联）总开关；false 时只保留文字聊天。 */
  voiceEnabled: boolean;
  elevenlabs: {
    apiKey?: string;
    voiceId?: string;
    model?: string;
    language?: string;
    configured: boolean;
  };
  qwenRealtime: {
    apiKey?: string;
    /** End-to-end S2S model used by the `s2s` voice mode. */
    model: string;
    baseUrl: string;
    /** S2S speaker voice (e.g. `longanqian`). */
    voice: string;
    voiceMode: 's2s' | 'cascade';
    /** ASR model used by the `cascade` voice mode. */
    asrModel: string;
    /** TTS model used by the `cascade` voice mode. */
    ttsModel: string;
    /** TTS voice used by the cascade mode. */
    ttsVoice: string;
    configured: boolean;
  };
  databaseUrl?: string;
  homeAssistant: {
    url?: string;
    token?: string;
  };
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid environment configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export interface LoadConfigOptions {
  loadDotenv?: boolean;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): AppConfig {
  if (options.loadDotenv !== false) {
    loadDotenv();
  }

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  const v = parsed.data;
  return {
    nodeEnv: v.NODE_ENV,
    port: v.PORT,
    logLevel: v.LOG_LEVEL,
    llmProvider: v.LLM_PROVIDER,
    llmFallback: {
      provider: v.LLM_FALLBACK_PROVIDER,
      model: v.LLM_FALLBACK_MODEL,
      configured:
        v.LLM_FALLBACK_PROVIDER !== 'none' &&
        Boolean(
          v.LLM_FALLBACK_PROVIDER === 'openrouter' ? v.OPENROUTER_API_KEY : v.DASHSCOPE_API_KEY,
        ),
    },
    openrouter: {
      apiKey: v.OPENROUTER_API_KEY,
      model: v.OPENROUTER_MODEL,
      voiceModel: v.OPENROUTER_VOICE_MODEL,
      baseUrl: v.OPENROUTER_BASE_URL,
      configured: Boolean(v.OPENROUTER_API_KEY),
    },
    dashscope: {
      apiKey: v.DASHSCOPE_API_KEY,
      model: v.DASHSCOPE_LLM_MODEL,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      configured: Boolean(v.DASHSCOPE_API_KEY),
    },
    deepseek: {
      apiKey: v.DEEPSEEK_API_KEY,
      model: v.DEEPSEEK_LLM_MODEL,
      baseUrl: v.DEEPSEEK_BASE_URL,
      configured: Boolean(v.DEEPSEEK_API_KEY),
    },
    voiceEnabled: v.VOICE_ENABLED === 'true',
    elevenlabs: {
      apiKey: v.ELEVENLABS_API_KEY,
      voiceId: v.ELEVENLABS_VOICE_ID,
      model: v.ELEVENLABS_MODEL,
      language: v.ELEVENLABS_LANGUAGE,
      configured: Boolean(v.ELEVENLABS_API_KEY && v.ELEVENLABS_VOICE_ID),
    },
    qwenRealtime: {
      apiKey: v.DASHSCOPE_API_KEY,
      model: v.QWEN_REALTIME_MODEL,
      baseUrl: v.QWEN_REALTIME_BASE_URL,
      voice: v.QWEN_REALTIME_VOICE,
      voiceMode: v.QWEN_VOICE_MODE,
      asrModel: v.QWEN_ASR_MODEL,
      ttsModel: v.QWEN_TTS_MODEL,
      ttsVoice: v.QWEN_TTS_VOICE,
      configured: Boolean(v.DASHSCOPE_API_KEY),
    },
    databaseUrl: v.DATABASE_URL,
    homeAssistant: {
      url: v.HOME_ASSISTANT_URL,
      token: v.HOME_ASSISTANT_TOKEN,
    },
  };
}
