import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
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
  InMemoryTimelineStore,
  InMemorySessionStore,
  InMemoryTaskStore,
  InMemoryProfileStore,
  InMemoryReminderStore,
  PostgresMemoryStore,
  PostgresProfileStore,
  PostgresReminderStore,
  PostgresSessionStore,
  PostgresTaskStore,
  PostgresTimelineStore,
} from '@personal-ai/memory';
import { ToolRegistry, createBuiltinTools } from '@personal-ai/tools';
import { buildApp } from './app.js';
import { ApprovalRegistry } from './services/approval.js';
import { resolveSearchRoots } from './services/search-roots.js';
import { ConversationService } from './services/conversation.js';
import { TaskService, validateCronSchedule } from './services/task-service.js';
import { ReminderService } from './services/reminder-service.js';
import { createCodingTool } from './services/coding-tool.js';
import {
  createEngineerStatusTool,
  createEngineerTool,
} from './services/engineer-tools.js';
import { EngineerTaskRunner } from './services/engineer-task-runner.js';
import { createOpsStatusTool, createOpsTaskRunner, createOpsTool } from './services/ops-tools.js';
import {
  createDesignerStatusTool,
  createDesignerTool,
  XIAO_MEI_COLLEAGUE,
} from './services/designer-tools.js';
import { createQaStatusTool, createQaTool, XIAO_ZHEN_COLLEAGUE } from './services/qa-tools.js';
import {
  createResearchStatusTool,
  createResearchTool,
  XIAO_ZHI_COLLEAGUE,
} from './services/research-tools.js';
import { ColleagueTaskRunner } from './services/colleague-task-runner.js';
import { ColleagueOffice } from './services/colleague-office.js';
import { createMailAskTool, createMailSendTool } from './services/colleague-tools.js';
import { createSelfTools } from './services/self-tools.js';
import { recoverInterruptedSessions } from './services/restart-recovery.js';
import { createWeixinTools } from './services/weixin-tools.js';
import { createCloudTools } from './services/cloud-tools.js';
import { createServerShellTool } from './services/server-shell.js';
import { createSystemStatusTool } from './services/system-status.js';
import { createProfileTools } from './services/profile-tools.js';
import { ProfileIngestor } from './services/profile-ingestor.js';
import { createTimelineTools } from './services/timeline-tools.js';
import { HookService } from './services/hook-service.js';

const config = loadConfig();
const processStartedAt = Date.now();
console.log(
  `[config] autoApproveAll=${config.autoApproveAll} provider=${config.llmProvider} voice=${config.voiceEnabled} tts=${config.voiceTtsEnabled}`,
);

/** 读宿主机 uptime（容器与宿主机共享内核，/proc/uptime 即宿主机值）。 */
async function readHostUptimeSeconds(): Promise<number | null> {
  try {
    const text = await readFile('/proc/uptime', 'utf8');
    return parseFloat(text.split(/\s+/)[0] ?? '0') || 0;
  } catch {
    return null;
  }
}

/**
 * 文件搜索根（N4-P1-1）：Linux/容器不再 exec powershell 枚举盘符
 * （容器里必失败且同步阻塞 10 秒），改走显式配置或默认根。
 * 解析逻辑在 services/search-roots.ts（可测试）。
 */
const searchRoots = resolveSearchRoots({
  configured: process.env.FILESYSTEM_SEARCH_ROOTS,
});
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
let profileStore: InMemoryProfileStore | PostgresProfileStore = new InMemoryProfileStore();
let timelineStore: InMemoryTimelineStore | PostgresTimelineStore = new InMemoryTimelineStore();
let reminderStore: InMemoryReminderStore | PostgresReminderStore = new InMemoryReminderStore();
if (config.databaseUrl) {
  const postgresMemory = new PostgresMemoryStore({
    connectionString: config.databaseUrl,
    embedder: memoryEmbedder,
  });
  const postgresTasks = new PostgresTaskStore({ connectionString: config.databaseUrl });
  const postgresProfiles = new PostgresProfileStore({ connectionString: config.databaseUrl });
  const postgresTimeline = new PostgresTimelineStore({ connectionString: config.databaseUrl });
  const postgresReminders = new PostgresReminderStore({ connectionString: config.databaseUrl });
  try {
    await postgresMemory.init();
    await postgresTasks.init();
    await postgresProfiles.init();
    await postgresTimeline.init();
    await postgresReminders.init();
    memory = postgresMemory;
    taskStore = postgresTasks;
    profileStore = postgresProfiles;
    timelineStore = postgresTimeline;
    reminderStore = postgresReminders;
    memoryBackend = 'postgres';
    console.log(`[memory] embedding: dashscope/${memoryEmbedder.dimensions ?? 'local'}`);
    // 脱敏打印：只显示 host:port，不含用户/密码（split('@')[1] 会带出 credential 段）
    let dbHost = 'postgres';
    try {
      const parsed = new URL(config.databaseUrl);
      dbHost = parsed.host;
    } catch {
      // URL 解析失败保持默认占位，不外泄原始串
    }
    console.log(`[memory] using postgres (${dbHost})`);
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
        name: 'openrouter',
      })
    : config.llmProvider === 'deepseek'
      ? // 统一使用 deepseek-v4-flash（快、省），不做 pro 路由。
        new OpenRouterProvider({
          apiKey: config.deepseek.apiKey,
          baseUrl: config.deepseek.baseUrl,
          model: config.deepseek.model,
          name: 'deepseek',
        })
      : new OpenRouterProvider({
          apiKey: config.dashscope.apiKey,
          baseUrl: config.dashscope.baseUrl,
          model: config.dashscope.model,
          name: 'dashscope',
        });
const fallbackLlm =
  config.llmFallback.provider === 'openrouter'
    ? new OpenRouterProvider({
        apiKey: config.openrouter.apiKey,
        baseUrl: config.openrouter.baseUrl,
        model: config.llmFallback.model ?? config.openrouter.model,
        name: 'openrouter',
      })
    : config.llmFallback.provider === 'dashscope'
      ? new OpenRouterProvider({
          apiKey: config.dashscope.apiKey,
          baseUrl: config.dashscope.baseUrl,
          model: config.llmFallback.model ?? config.dashscope.model,
          name: 'dashscope',
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
// 对话后自动抽取画像（Mem0 两阶段思路）：快模型 + 节流 + 失败静默。
const profileIngestor = new ProfileIngestor({
  llm,
  store: profileStore,
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
  profile: profileStore,
  timeline: timelineStore,
  profileIngest: (message) => void profileIngestor.ingest(message),
  autoApproveAll: config.autoApproveAll,
});
const taskService = new TaskService({
  tasks: taskStore,
  sessions: store,
  conversation,
  systemPrompt: () => persona.getSystemPrompt(),
  timeline: timelineStore,
});

const { tools, stores } = createBuiltinTools({
  allowedSearchRoots: searchRoots,
  memoryStore: memory,
  reminders: reminderStore,
  tasks: {
    tasks: taskStore,
    createTaskSession: (action) => taskService.createTaskSession(action),
    validateSchedule: validateCronSchedule,
  },
});
for (const tool of tools) {
  // 内置 filesystem.delete 限定工作区且需要二次确认，容易让模型误报"不在工作区"，
  // 因此从不注册（而不是注册后 unregister）；微信侧的文件删除走 weixin.delete_file。
  if (tool.name === 'filesystem.delete') continue;
  toolRegistry.register(tool);
}
// coding.run 是服务端能力（服务器上驱动 dsh 开源编码代理），不属于桌面客户端。
toolRegistry.register(createCodingTool());
// 五位同事 *.delegate 都是异步派单：工具立即返回 taskId。同事用自己的持久会话
// headless 思考（工具白名单动手）；进度/完成通过事件推送，不阻塞小夜对话。
// 小夜用对应 *.status 查询。未接入会话时仍可回退 dsh runner。
const engineerTaskRunner = new EngineerTaskRunner({
  timeline: timelineStore,
  persistDir: process.env.ENGINEER_TASK_DIR ?? './data/engineer-tasks',
});
const opsTaskRunner = createOpsTaskRunner({
  timeline: timelineStore,
  persistDir: process.env.OPS_TASK_DIR ?? './data/ops-tasks',
});
const designerTaskRunner = new ColleagueTaskRunner(XIAO_MEI_COLLEAGUE, {
  timeline: timelineStore,
  persistDir: process.env.DESIGNER_TASK_DIR ?? './data/designer-tasks',
});
const qaTaskRunner = new ColleagueTaskRunner(XIAO_ZHEN_COLLEAGUE, {
  timeline: timelineStore,
  persistDir: process.env.QA_TASK_DIR ?? './data/qa-tasks',
});
const researchTaskRunner = new ColleagueTaskRunner(XIAO_ZHI_COLLEAGUE, {
  timeline: timelineStore,
  persistDir: process.env.RESEARCH_TASK_DIR ?? './data/research-tasks',
});
const colleagueRunners = [
  engineerTaskRunner,
  opsTaskRunner,
  designerTaskRunner,
  qaTaskRunner,
  researchTaskRunner,
];
const colleagueOffice = new ColleagueOffice({
  store,
  mailboxDir: process.env.COLLEAGUE_MAILBOX_DIR ?? './data/mailboxes',
  runners: {
    xiaohei: engineerTaskRunner,
    xiaoyou: opsTaskRunner,
    xiaomei: designerTaskRunner,
    xiaozhen: qaTaskRunner,
    xiaozhi: researchTaskRunner,
  },
});
colleagueOffice.attachConversation(conversation);
try {
  const ensured = await colleagueOffice.ensureSessions();
  const ids = [...ensured.entries()].map(([id, sessionId]) => `${id}=${sessionId.slice(0, 8)}`);
  console.log(`[colleagues] ensured ${ensured.size} session(s): ${ids.join(', ')}`);
} catch (error) {
  console.warn(
    `[colleagues] ensureSessions failed (${error instanceof Error ? error.message : String(error)}), continuing without colleague sessions`,
  );
}
// 返回中断任务列表（进程重启时被杀的 running 任务），事件通道就绪后补发通知
const interruptedColleagueTasks: Array<{ runner: ColleagueTaskRunner; id: string }> = [];
for (const runner of colleagueRunners) {
  for (const task of await runner.loadPersisted()) {
    interruptedColleagueTasks.push({ runner, id: task.id });
  }
}
try {
  await colleagueOffice.hydrate();
} catch (error) {
  console.warn(
    `[colleagues] hydrate failed (${error instanceof Error ? error.message : String(error)})`,
  );
}
toolRegistry.register(createEngineerTool(engineerTaskRunner, colleagueOffice));
toolRegistry.register(createEngineerStatusTool(engineerTaskRunner, colleagueOffice));
toolRegistry.register(createOpsTool(opsTaskRunner, colleagueOffice));
toolRegistry.register(createOpsStatusTool(opsTaskRunner, colleagueOffice));
toolRegistry.register(createDesignerTool(designerTaskRunner, colleagueOffice));
toolRegistry.register(createDesignerStatusTool(designerTaskRunner, colleagueOffice));
toolRegistry.register(createQaTool(qaTaskRunner, colleagueOffice));
toolRegistry.register(createQaStatusTool(qaTaskRunner, colleagueOffice));
toolRegistry.register(createResearchTool(researchTaskRunner, colleagueOffice));
toolRegistry.register(createResearchStatusTool(researchTaskRunner, colleagueOffice));
toolRegistry.register(createMailAskTool(colleagueOffice));
toolRegistry.register(createMailSendTool(colleagueOffice));
// server.shell：容器内终端（L3）——"云服务器即她的世界"的自主操作入口。
toolRegistry.register(createServerShellTool());
// system.status：服务器健康巡检（L0 只读）——定时任务自主监控用。
toolRegistry.register(createSystemStatusTool());
// 用户画像：结构化记住用户的事实/偏好/习惯，跨会话注入。
for (const tool of createProfileTools({ store: profileStore, llm })) {
  toolRegistry.register(tool);
}
// 事件时间线：记录/查看"我们之间发生过什么"。
for (const tool of createTimelineTools({ store: timelineStore })) {
  toolRegistry.register(tool);
}
// 自我开发：self.info / self.check / system.restart（守护进程/容器负责重启拉起）。
for (const tool of createSelfTools({ memoryBackend, memory, personaDir })) {
  toolRegistry.register(tool);
}
// 微信媒体发送：weixin.send_image / weixin.send_voice（桥在服务端负责上传与投递）。
const weixinBridgeUrl = process.env.WEIXIN_BRIDGE_URL ?? 'http://127.0.0.1:3100';
for (const tool of createWeixinTools({
  bridgeUrl: weixinBridgeUrl,
  store,
  bridgeToken: config.bridgeToken,
})) {
  toolRegistry.register(tool);
}
// 腾讯云轻量服务器管理：实例状态 / 防火墙规则（凭据来自环境变量，未配置则不注册）。
if (config.tencent.configured) {
  for (const tool of createCloudTools({
    secretId: config.tencent.secretId!,
    secretKey: config.tencent.secretKey!,
    region: config.tencent.region,
    instanceId: config.tencent.lighthouseInstanceId,
    timeline: timelineStore,
  })) {
    toolRegistry.register(tool);
  }
} else {
  console.warn('[cloud-tools] TENCENT_SECRET_ID/TENCENT_SECRET_KEY 未配置，cloud.* 工具未注册');
}
taskService.start();
const reminderService = new ReminderService({ reminders: stores.reminders });
reminderService.start();
// 事件驱动监听：外部 webhook 推入 → AI 主动评估/处理 → 微信汇报。
const hookService = new HookService({
  conversation,
  sessions: store,
  systemPrompt: () => persona.getSystemPrompt(),
  timeline: timelineStore,
});

// 宿主机是否刚开机：决定是否发"云服务器重启完成"通知（真重启才发，
// 普通部署/容器重启不误报）。
const hostUptimeSeconds = await readHostUptimeSeconds();
const hostBootedRecently = hostUptimeSeconds !== null && hostUptimeSeconds < 10 * 60;
console.log(
  `[boot] host uptime=${hostUptimeSeconds ?? 'unknown'}s，` +
    (hostBootedRecently ? '检测到真重启，将发送重启完成通知' : '部署/常规重启，抑制重启通知'),
);

const app = buildApp({
  config,
  store,
  llm,
  voiceLlm,
  persona,
  tools: toolRegistry,
  approvals,
  memory,
  profile: profileStore,
  timeline: timelineStore,
  profileIngest: (message) => void profileIngestor.ingest(message),
  subscribeTaskEvents: (listener) => taskService.onRun(listener),
  subscribeReminderEvents: (listener) => reminderService.onDue(listener),
  subscribeHookEvents: (listener) => hookService.onRun(listener),
  subscribeEngineerEvents: (listener) => {
    const unsubs = [
      ...colleagueRunners.map((runner) => runner.onEvent(listener)),
      colleagueOffice.onEvent(listener),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  },
  hooks: hookService,
  hookSecret: config.hookSecret,
  processStartedAt,
  hostBootedRecently,
  createVoice,
  createTTS,
  createQwen,
});

// 事件订阅（registerEventRoutes）已建立：补发重启中断的同事任务完成通知，
// 这些事件会进 SSE 缓冲，晚连接的 weixin event-pusher 也能靠 Last-Event-ID 拉到。
for (const item of interruptedColleagueTasks) {
  item.runner.emitTaskDone(item.id);
}

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
  colleagueOffice.close();
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// A long-running server must not die from a single connection error.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[server] uncaughtException:', error);
});
