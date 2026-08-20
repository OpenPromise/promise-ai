import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { AppConfig } from '@personal-ai/config';
import type { PersonaProvider } from '@personal-ai/core';
import type { TTSProvider, VoiceGateway } from '@personal-ai/elevenlabs';
import type { LLMProvider } from '@personal-ai/llm';
import type {
  AvatarStore,
  MemoryStore,
  ProfileStore,
  SessionStore,
  TimelineStore,
} from '@personal-ai/memory';
import type { QwenRealtimeClient } from '@personal-ai/qwen-realtime';
import type { ToolRegistry } from '@personal-ai/tools';
import { registerHealthRoutes } from './routes/health.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerVoiceRoutes } from './routes/voice.js';
import { registerQwenVoiceRoutes } from './routes/qwen-voice.js';
import { registerQwenS2SVoiceRoutes } from './routes/qwen-voice-s2s.js';
import { registerDesktopRoutes } from './routes/desktop.js';
import { registerEventRoutes } from './routes/events.js';
import { registerHookRoutes } from './routes/hooks.js';
import { registerAvatarRoutes } from './routes/avatar.js';
import { ApprovalRegistry } from './services/approval.js';
import { ConversationService } from './services/conversation.js';
import type { ReminderDueEvent } from './services/reminder-service.js';
import type { TaskRunEvent } from './services/task-service.js';
import type { HookRunEvent, HookService } from './services/hook-service.js';

export interface AppDeps {
  config: AppConfig;
  store: SessionStore;
  llm: LLMProvider;
  /** Low-latency LLM for the voice cascade; falls back to `llm` when unset. */
  voiceLlm?: LLMProvider;
  persona: PersonaProvider;
  tools: ToolRegistry;
  approvals: ApprovalRegistry;
  memory: MemoryStore;
  /** 用户画像存储（结构化长期关系记忆，注入对话上下文）。 */
  profile?: ProfileStore;
  /** 事件时间线（记录/注入"发生过什么"）。 */
  timeline?: TimelineStore;
  /** 对话正常结束后异步抽取画像（Mem0 两阶段思路）。 */
  profileIngest?: (userMessage: string) => void;
  memoryBackend: string;
  sessionBackend: string;
  createVoice: () => VoiceGateway;
  /** ElevenLabs TTS used by the Qwen ASR -> LLM -> TTS cascade. */
  createTTS?: () => TTSProvider;
  /** Creates a Qwen realtime client for the given model (ASR or TTS). */
  createQwen?: (model: string) => QwenRealtimeClient;
  /** 任务运行事件订阅（桌面端通知闭环）。 */
  subscribeTaskEvents?: (listener: (event: TaskRunEvent) => void) => () => void;
  /** 提醒到期事件订阅（桌面端通知闭环）。 */
  subscribeReminderEvents?: (listener: (event: ReminderDueEvent) => void) => () => void;
  /** 外部事件（webhook）处理结果订阅。 */
  subscribeHookEvents?: (listener: (event: HookRunEvent) => void) => () => void;
  /** 事件驱动监听服务（webhook 入口）。 */
  hooks?: HookService;
  /** webhook 共享密钥（可选）。 */
  hookSecret?: string;
  /** 可成长 Avatar 存储（可选，配置后注册 /avatar 与 API）。 */
  avatarStore?: AvatarStore;
  /** public/ 静态资源目录（avatar 页面/模型）。 */
  publicDir?: string;
  /** 进程启动时间戳：用于重启完成通知（开机自启闭环）。 */
  processStartedAt?: number;
  /** 宿主机是否刚开机（< 10 分钟）；区分真重启与部署/容器重启。 */
  hostBootedRecently?: boolean;
}

/** 空 TTS：语音输出禁用时使用（ASR 仍工作，回复以文字形式发送）。 */
function createNoopTTS(): TTSProvider {
  return {
    configured: false,
    async *synthesize() {
      yield* [];
    },
  };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: deps.config.logLevel },
  });

  const conversation = new ConversationService({
    store: deps.store,
    llm: deps.llm,
    tools: deps.tools,
    approvals: deps.approvals,
    memory: deps.memory,
    profile: deps.profile,
    timeline: deps.timeline,
    profileIngest: deps.profileIngest,
    autoApproveAll: deps.config.autoApproveAll,
  });

  registerHealthRoutes(app, {
    config: deps.config,
    llm: deps.llm,
    memoryBackend: deps.memoryBackend,
  });
  if (deps.subscribeTaskEvents || deps.subscribeReminderEvents) {
    registerEventRoutes(app, {
      subscribeTaskEvents: deps.subscribeTaskEvents ?? (() => () => {}),
      subscribeReminderEvents: deps.subscribeReminderEvents ?? (() => () => {}),
      subscribeHookEvents: deps.subscribeHookEvents,
      processStartedAt: deps.processStartedAt,
      hostBootedRecently: deps.hostBootedRecently,
    });
  }
  if (deps.hooks) {
    registerHookRoutes(app, { hooks: deps.hooks, secret: deps.hookSecret });
  }
  if (deps.avatarStore && deps.publicDir) {
    registerAvatarRoutes(app, { store: deps.avatarStore, publicDir: deps.publicDir });
  }
  registerSessionRoutes(app, {
    store: deps.store,
    llm: deps.llm,
    persona: deps.persona,
    conversation,
    approvals: deps.approvals,
  });

  // The websocket plugin must be registered in the same encapsulation as the
  // websocket routes so its `onRoute` hook rewrites the handlers.
  app.register(async (instance) => {
    await instance.register(websocket, { options: { maxPayload: 1024 * 1024 } });
    registerDesktopRoutes(instance, { registry: deps.tools });
    // 语音总开关：VOICE_ENABLED=false 时只保留文字聊天（桌面端语音会断开）
    if (deps.config.voiceEnabled) {
      if (deps.config.qwenRealtime.configured && deps.createQwen) {
        if (deps.config.qwenRealtime.voiceMode === 's2s' && deps.config.voiceTtsEnabled) {
          // End-to-end speech-to-speech: lowest latency, reasoning is Qwen's own.
          registerQwenS2SVoiceRoutes(instance, {
            store: deps.store,
            tools: deps.tools,
            approvals: deps.approvals,
            voice: deps.config.qwenRealtime.voice,
            createQwen: () => deps.createQwen!(deps.config.qwenRealtime.model),
            // 语音委托子代理：复杂/多步任务交给文本推理代理执行（OpenDex run_task 模式）。
            conversation: new ConversationService({
              store: deps.store,
              llm: deps.llm,
              tools: deps.tools,
              approvals: deps.approvals,
              memory: deps.memory,
              autoApproveAll: deps.config.autoApproveAll,
            }),
          });
        } else {
          // Qwen ASR -> LLM -> ElevenLabs TTS cascade. The voice conversation
          // uses voiceLlm (fast) while text chat keeps the full-strength llm.
          const voiceConversation = new ConversationService({
            store: deps.store,
            llm: deps.voiceLlm ?? deps.llm,
            tools: deps.tools,
            approvals: deps.approvals,
            memory: deps.memory,
            autoApproveAll: deps.config.autoApproveAll,
          });
          registerQwenVoiceRoutes(instance, {
            store: deps.store,
            conversation: voiceConversation,
            approvals: deps.approvals,
            createQwenASR: () => deps.createQwen!(deps.config.qwenRealtime.asrModel),
            createTTS: deps.config.voiceTtsEnabled
              ? (deps.createTTS ?? (() => deps.createVoice().tts))
              : createNoopTTS,
          });
        }
      } else {
        // ElevenLabs STT->LLM->TTS 旧链路：语音输出关闭时同样跳过
        if (deps.config.voiceTtsEnabled) {
          registerVoiceRoutes(instance, {
            store: deps.store,
            conversation,
            approvals: deps.approvals,
            createVoice: deps.createVoice,
          });
        }
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      const message =
        'message' in error && typeof error.message === 'string' ? error.message : 'Bad request';
      return reply.code(error.statusCode).send({ error: message });
    }
    request.log.error({ err: error }, 'unhandled error');
    reply.code(500).send({ error: 'Internal server error' });
  });

  return app;
}
