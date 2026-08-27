import { readFile } from 'node:fs/promises';
import { ElevenLabsSTT, ElevenLabsTTS } from '@personal-ai/elevenlabs';
import { QwenRealtimeClient } from '@personal-ai/qwen-realtime';
import { ReminderService } from './services/reminder-service.js';
import {
  createEngineerStatusTool,
  createEngineerTool,
} from './services/engineer-tools.js';
import { createOpsStatusTool, createOpsTool } from './services/ops-tools.js';
import {
  createDesignerStatusTool,
  createDesignerTool,
} from './services/designer-tools.js';
import { createQaStatusTool, createQaTool } from './services/qa-tools.js';
import {
  createResearchStatusTool,
  createResearchTool,
} from './services/research-tools.js';
import type { ColleagueTaskRunner } from './services/colleague-task-runner.js';
import { createSelfTools } from './services/self-tools.js';
import { createWeixinTools } from './services/weixin-tools.js';
import { createCloudTools } from './services/cloud-tools.js';
import { createProfileTools } from './services/profile-tools.js';
import { createTimelineTools } from './services/timeline-tools.js';
import { HookService } from './services/hook-service.js';
import { buildApp } from './app.js';
import { createAgentCore } from './agent-core.js';
import { registerColleagueInternalRoutes } from './routes/colleague-internal.js';

const processStartedAt = Date.now();

/** 读宿主机 uptime（容器与宿主机共享内核，/proc/uptime 即宿主机值）。 */
async function readHostUptimeSeconds(): Promise<number | null> {
  try {
    const text = await readFile('/proc/uptime', 'utf8');
    return parseFloat(text.split(/\s+/)[0] ?? '0') || 0;
  } catch {
    return null;
  }
}

const core = await createAgentCore({ role: 'parent' });
const {
  config,
  store,
  sessionBackend,
  memory,
  memoryBackend,
  profileStore,
  timelineStore,
  reminderStore,
  persona,
  personaDir,
  llm,
  fallbackLlm,
  voiceLlm,
  toolRegistry,
  approvals,
  conversation,
  colleagueOffice,
  colleagueRunners,
  engineerTaskRunner,
  opsTaskRunner,
  designerTaskRunner,
  qaTaskRunner,
  researchTaskRunner,
  profileIngestor,
} = core;

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

const taskService = core.taskService;

const interruptedColleagueTasks: Array<{ runner: ColleagueTaskRunner; id: string }> = [];
for (const runner of colleagueRunners) {
  for (const task of await runner.loadPersisted()) {
    interruptedColleagueTasks.push({ runner, id: task.id });
  }
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

for (const tool of createProfileTools({ store: profileStore, llm })) {
  toolRegistry.register(tool);
}
for (const tool of createTimelineTools({ store: timelineStore })) {
  toolRegistry.register(tool);
}
for (const tool of createSelfTools({ memoryBackend, memory, personaDir })) {
  toolRegistry.register(tool);
}

const weixinBridgeUrl = process.env.WEIXIN_BRIDGE_URL ?? 'http://127.0.0.1:3100';
for (const tool of createWeixinTools({
  bridgeUrl: weixinBridgeUrl,
  store,
  bridgeToken: config.bridgeToken,
})) {
  toolRegistry.register(tool);
}

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
const reminderService = new ReminderService({ reminders: reminderStore });
reminderService.start();
const hookService = new HookService({
  conversation,
  sessions: store,
  systemPrompt: () => persona.getSystemPrompt(),
  timeline: timelineStore,
});

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

registerColleagueInternalRoutes(app, { office: colleagueOffice });

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
  await colleagueOffice.closeAndWait();
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[server] uncaughtException:', error);
});
