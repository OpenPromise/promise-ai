import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '@personal-ai/config';
import { FilePersonaProvider } from '@personal-ai/core';
import { ElevenLabsSTT, ElevenLabsTTS } from '@personal-ai/elevenlabs';
import { OpenRouterProvider } from '@personal-ai/openrouter';
import { QwenRealtimeClient } from '@personal-ai/qwen-realtime';
import { FallbackLLMProvider } from '@personal-ai/llm';
import {
  createDashScopeEmbedder,
  createLocalEmbedder,
  createResilientEmbedder,
  InMemoryMemoryStore,
  InMemorySessionStore,
  InMemoryTaskStore,
  PostgresMemoryStore,
  PostgresSessionStore,
  PostgresTaskStore,
} from '@personal-ai/memory';
import { ToolRegistry, createBuiltinTools } from '@personal-ai/tools';
import { buildApp } from './app.js';
import { ApprovalRegistry } from './services/approval.js';
import { ConversationService } from './services/conversation.js';
import { TaskService, validateCronSchedule } from './services/task-service.js';
import { ReminderService } from './services/reminder-service.js';
import { createCodingTool } from './services/coding-tool.js';
import { createSelfTools } from './services/self-tools.js';
import { recoverInterruptedSessions } from './services/restart-recovery.js';
import { createWeixinTools } from './services/weixin-tools.js';
import { createCloudTools } from './services/cloud-tools.js';
import { createRoutedLLMProvider } from './services/llm-router.js';

const config = loadConfig();
console.log(
  `[config] autoApproveAll=${config.autoApproveAll} provider=${config.llmProvider} voice=${config.voiceEnabled} tts=${config.voiceTtsEnabled}`,
);

/** Enumerates fixed drive roots (C:\, D:\ …) so file tools work anywhere on disk. */
function listFixedDriveRoots(): string[] {
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-PSDrive -PSProvider FileSystem).Root'],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
    );
    const roots = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z]:\\$/.test(line));
    if (roots.length > 0) return roots;
  } catch {
    // fall through to the workspace root
  }
  return [process.cwd()];
}

const searchRoots = listFixedDriveRoots();
console.log(`[filesystem] search roots: ${searchRoots.join(', ')}`);

// 记忆嵌入：百炼 text-embedding-v4（中文语义检索质量更好），
// 云接口失败时自动回退本地 bigram 嵌入，不阻断写入。
const memoryEmbedder = config.dashscope.apiKey
  ? createResilientEmbedder(
      createDashScopeEmbedder({ apiKey: config.dashscope.apiKey }),
      createLocalEmbedder(),
    )
  : createLocalEmbedder();

// Sessions: PostgreSQL when available (survives restarts), otherwise in-memory.
let store: InMemorySessionStore | PostgresSessionStore = new InMemorySessionStore();
let sessionBackend = 'memory';
if (config.databaseUrl) {
  const postgresSessions = new PostgresSessionStore({ connectionString: config.databaseUrl });
  try {
    await postgresSessions.init();
    store = postgresSessions;
    sessionBackend = 'postgres';
    const restored = await store.listSessions();
    console.log(`[sessions] using postgres (restored ${restored.length} session(s))`);
  } catch (error) {
    console.warn(
      `[sessions] postgres unavailable (${error instanceof Error ? error.message : String(error)}), falling back to in-memory`,
    );
    store = new InMemorySessionStore();
  }
}

// Long-term memory: PostgreSQL + pgvector when available, otherwise in-memory.
let memory: InMemoryMemoryStore | PostgresMemoryStore = new InMemoryMemoryStore();
let memoryBackend = 'memory';
let taskStore: InMemoryTaskStore | PostgresTaskStore = new InMemoryTaskStore();
if (config.databaseUrl) {
  const postgresMemory = new PostgresMemoryStore({
    connectionString: config.databaseUrl,
    embedder: memoryEmbedder,
  });
  const postgresTasks = new PostgresTaskStore({ connectionString: config.databaseUrl });
  try {
    await postgresMemory.init();
    await postgresTasks.init();
    memory = postgresMemory;
    taskStore = postgresTasks;
    memoryBackend = 'postgres';
    console.log(`[memory] embedding: dashscope/${memoryEmbedder.dimensions ?? 'local'}`);
    console.log(`[memory] using postgres (${config.databaseUrl.split('@')[1] ?? ''})`);
  } catch (error) {
    console.warn(
      `[memory] postgres unavailable (${error instanceof Error ? error.message : String(error)}), falling back to in-memory`,
    );
    memory = new InMemoryMemoryStore(memoryEmbedder);
    taskStore = new InMemoryTaskStore();
  }
}

// 重启恢复上报（OpenCrabs 思路）：服务被拉起后，给存在中断工具调用的会话
// 注入提示，让用户与模型都知道上次任务被打断。
if (sessionBackend === 'postgres') {
  try {
    const { recovered, sessionIds } = await recoverInterruptedSessions(store);
    if (recovered > 0) {
      console.log(
        `[recovery] ${recovered} 个会话存在中断的工具调用，已注入恢复提示：${sessionIds.join(', ')}`,
      );
    }
  } catch (error) {
    console.warn(
      `[recovery] 扫描中断会话失败（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

const personaDir = fileURLToPath(new URL('../../../persona', import.meta.url));
const persona = new FilePersonaProvider({
  personaDir,
  ...(config.elevenlabs.voiceId
    ? {
        voiceProfile: {
          voiceId: config.elevenlabs.voiceId,
          ...(config.elevenlabs.model ? { model: config.elevenlabs.model } : {}),
        },
      }
    : {}),
});
// Every voice WebSocket connection gets its own STT/TTS clients so concurrent
// sessions never share transcript events or audio streams.
const createVoice = () => ({
  tts: new ElevenLabsTTS({
    apiKey: config.elevenlabs.apiKey,
    voiceId: config.elevenlabs.voiceId,
    modelId: config.elevenlabs.model,
    languageCode: config.elevenlabs.language,
  }),
  stt: new ElevenLabsSTT({
    apiKey: config.elevenlabs.apiKey,
    languageCode: config.elevenlabs.language,
    vadSilenceThresholdSecs: 0.6,
  }),
});
const createQwen = (model: string) =>
  new QwenRealtimeClient({
    apiKey: config.qwenRealtime.apiKey,
    baseUrl: config.qwenRealtime.baseUrl,
    model,
  });
const createTTS = () =>
  new ElevenLabsTTS({
    apiKey: config.elevenlabs.apiKey,
    voiceId: config.elevenlabs.voiceId,
    modelId: config.elevenlabs.model,
    languageCode: config.elevenlabs.language,
  });
// Text reasoning: DashScope (Qwen) by default, with OpenRouter as an optional
// alternative — both speak the same OpenAI-compatible protocol. OpenCrabs 式
// 故障转移：主模型未产出内容即失败时，透明切换到备用后端。
const primaryLlm =
  config.llmProvider === 'openrouter'
    ? new OpenRouterProvider({
        apiKey: config.openrouter.apiKey,
        baseUrl: config.openrouter.baseUrl,
        model: config.openrouter.model,
      })
    : config.llmProvider === 'deepseek'
      ? // flash/pro 双速路由：日常走 flash（快、省），复杂任务切 pro（强）。
        // 语音级联仍用单独构造的 voiceLlm（保持低延迟）。
        createRoutedLLMProvider({
          fast: new OpenRouterProvider({
            apiKey: config.deepseek.apiKey,
            baseUrl: config.deepseek.baseUrl,
            model: config.deepseek.model,
          }),
          smart: new OpenRouterProvider({
            apiKey: config.deepseek.apiKey,
            baseUrl: config.deepseek.baseUrl,
            model: config.deepseek.proModel,
          }),
          onRoute: (_input, model) =>
            console.log(`[llm-router] ${model === 'smart' ? 'pro' : 'flash'} 处理本次请求`),
        })
      : new OpenRouterProvider({
          apiKey: config.dashscope.apiKey,
          baseUrl: config.dashscope.baseUrl,
          model: config.dashscope.model,
        });
const fallbackLlm =
  config.llmFallback.provider === 'openrouter'
    ? new OpenRouterProvider({
        apiKey: config.openrouter.apiKey,
        baseUrl: config.openrouter.baseUrl,
        model: config.llmFallback.model ?? config.openrouter.model,
      })
    : config.llmFallback.provider === 'dashscope'
      ? new OpenRouterProvider({
          apiKey: config.dashscope.apiKey,
          baseUrl: config.dashscope.baseUrl,
          model: config.llmFallback.model ?? config.dashscope.model,
        })
      : undefined;
const llm = new FallbackLLMProvider({
  primary: primaryLlm,
  ...(fallbackLlm
    ? {
        fallback: fallbackLlm,
        onFailover: (from, to, error) =>
          console.warn(
            `[llm] ${from.name}/${from.model} 未产出即失败（${error instanceof Error ? error.message : String(error)}），切换至 ${to.name}/${to.model}`,
          ),
      }
    : {}),
});
// Voice cascade may use a faster model than text chat to cut latency; with
// DashScope the same Qwen model is used for both.
const primaryVoiceLlm =
  config.llmProvider === 'openrouter'
    ? new OpenRouterProvider({
        apiKey: config.openrouter.apiKey,
        baseUrl: config.openrouter.baseUrl,
        model: config.openrouter.voiceModel,
      })
    : config.llmProvider === 'deepseek'
      ? new OpenRouterProvider({
          apiKey: config.deepseek.apiKey,
          baseUrl: config.deepseek.baseUrl,
          model: config.deepseek.model,
        })
      : new OpenRouterProvider({
          apiKey: config.dashscope.apiKey,
          baseUrl: config.dashscope.baseUrl,
          model: config.dashscope.model,
        });
const voiceLlm = new FallbackLLMProvider({
  primary: primaryVoiceLlm,
  ...(fallbackLlm
    ? {
        fallback: fallbackLlm,
        onFailover: (from, to, error) =>
          console.warn(
            `[voice-llm] ${from.name}/${from.model} 未产出即失败（${error instanceof Error ? error.message : String(error)}），切换至 ${to.name}/${to.model}`,
          ),
      }
    : {}),
});

const toolRegistry = new ToolRegistry();
const approvals = new ApprovalRegistry();
const conversation = new ConversationService({
  store,
  llm,
  tools: toolRegistry,
  approvals,
  memory,
  autoApproveAll: config.autoApproveAll,
});
const taskService = new TaskService({
  tasks: taskStore,
  sessions: store,
  conversation,
  systemPrompt: () => persona.getSystemPrompt(),
});

const { tools, stores } = createBuiltinTools({
  allowedSearchRoots: searchRoots,
  memoryStore: memory,
  tasks: {
    tasks: taskStore,
    createTaskSession: (action) => taskService.createTaskSession(action),
    validateSchedule: validateCronSchedule,
  },
});
for (const tool of tools) {
  toolRegistry.register(tool);
}
// coding.run 是服务端能力（服务器上驱动 dsh/Claude Code），不属于桌面客户端。
toolRegistry.register(createCodingTool());
// 自我开发：self.info / self.check / system.restart（守护进程/容器负责重启拉起）。
for (const tool of createSelfTools({ memoryBackend, memory, personaDir })) {
  toolRegistry.register(tool);
}
// 微信媒体发送：weixin.send_image / weixin.send_voice（桥在服务端负责上传与投递）。
const weixinBridgeUrl = process.env.WEIXIN_BRIDGE_URL ?? 'http://127.0.0.1:3100';
for (const tool of createWeixinTools({ bridgeUrl: weixinBridgeUrl, store })) {
  toolRegistry.register(tool);
}
// 腾讯云轻量服务器管理：实例状态 / 防火墙规则（凭据来自环境变量，未配置则不注册）。
if (config.tencent.configured) {
  for (const tool of createCloudTools({
    secretId: config.tencent.secretId!,
    secretKey: config.tencent.secretKey!,
    region: config.tencent.region,
    instanceId: config.tencent.lighthouseInstanceId,
  })) {
    toolRegistry.register(tool);
  }
} else {
  console.warn('[cloud-tools] TENCENT_SECRET_ID/TENCENT_SECRET_KEY 未配置，cloud.* 工具未注册');
}
// 删除工具由桌面端提供（filesystem.delete，L1 自动执行、不限制路径）；内置版
// 限定工作区且需要二次确认，容易让模型误报"不在工作区"，因此不注册。
toolRegistry.unregister('filesystem.delete');
taskService.start();
const reminderService = new ReminderService({ reminders: stores.reminders });
reminderService.start();

const app = buildApp({
  config,
  store,
  llm,
  voiceLlm,
  persona,
  tools: toolRegistry,
  approvals,
  memory,
  memoryBackend,
  sessionBackend,
  subscribeTaskEvents: (listener) => taskService.onRun(listener),
  subscribeReminderEvents: (listener) => reminderService.onDue(listener),
  createVoice,
  createTTS,
  createQwen,
});

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(
    {
      port: config.port,
      llmConfigured: llm.configured,
      llmProvider: config.llmProvider,
      llmModel: llm.model,
      llmFallback: config.llmFallback.provider,
      llmFallbackModel: fallbackLlm?.model,
      voiceLlmModel: voiceLlm?.model,
      voiceMode: config.qwenRealtime.voiceMode,
      qwenVoiceModel: config.qwenRealtime.model,
      voiceConfigured: config.elevenlabs.configured,
      qwenRealtimeConfigured: config.qwenRealtime.configured,
      sessionBackend,
      memoryBackend,
    },
    'agent-server started',
  );
} catch (error) {
  app.log.error({ err: error }, 'failed to start agent-server');
  process.exit(1);
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down agent-server');
  taskService.stop();
  reminderService.stop();
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// A long-running desktop assistant must not die from a single connection error.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[server] uncaughtException:', error);
});
