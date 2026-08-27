import { fileURLToPath } from 'node:url';
import { loadConfig } from '@personal-ai/config';
import { FilePersonaProvider } from '@personal-ai/core';
import { OpenRouterProvider } from '@personal-ai/openrouter';
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
import { ApprovalRegistry } from './services/approval.js';
import { resolveSearchRoots } from './services/search-roots.js';
import { ConversationService } from './services/conversation.js';
import { TaskService, validateCronSchedule } from './services/task-service.js';
import { createCodingTool } from './services/coding-tool.js';
import { EngineerTaskRunner } from './services/engineer-task-runner.js';
import { createOpsTaskRunner } from './services/ops-tools.js';
import { XIAO_MEI_COLLEAGUE } from './services/designer-tools.js';
import { XIAO_ZHEN_COLLEAGUE } from './services/qa-tools.js';
import { XIAO_ZHI_COLLEAGUE } from './services/research-tools.js';
import { ColleagueTaskRunner } from './services/colleague-task-runner.js';
import {
  ColleagueOffice,
  parseColleagueId,
  type ColleagueId,
} from './services/colleague-office.js';
import { createMailAskTool, createMailSendTool } from './services/colleague-tools.js';
import { createServerShellTool } from './services/server-shell.js';
import { createSystemStatusTool } from './services/system-status.js';
import { ProfileIngestor } from './services/profile-ingestor.js';
import { colleagueForkEnabled } from './services/colleague-fork.js';
import { recoverInterruptedSessions } from './services/restart-recovery.js';

export type AgentRole = 'parent' | 'worker';

export interface AgentCore {
  config: ReturnType<typeof loadConfig>;
  store: InMemorySessionStore | PostgresSessionStore;
  sessionBackend: string;
  memory: InMemoryMemoryStore | PostgresMemoryStore;
  memoryBackend: string;
  taskStore: InMemoryTaskStore | PostgresTaskStore;
  profileStore: InMemoryProfileStore | PostgresProfileStore;
  timelineStore: InMemoryTimelineStore | PostgresTimelineStore;
  reminderStore: InMemoryReminderStore | PostgresReminderStore;
  persona: FilePersonaProvider;
  personaDir: string;
  llm: FallbackLLMProvider;
  fallbackLlm: OpenRouterProvider | undefined;
  voiceLlm: FallbackLLMProvider;
  toolRegistry: ToolRegistry;
  approvals: ApprovalRegistry;
  conversation: ConversationService;
  taskService: TaskService;
  colleagueOffice: ColleagueOffice;
  colleagueRunners: ColleagueTaskRunner[];
  engineerTaskRunner: EngineerTaskRunner;
  opsTaskRunner: ColleagueTaskRunner;
  designerTaskRunner: ColleagueTaskRunner;
  qaTaskRunner: ColleagueTaskRunner;
  researchTaskRunner: ColleagueTaskRunner;
  profileIngestor: ProfileIngestor;
  searchRoots: string[];
}

export async function createAgentCore(options: {
  role: AgentRole;
  colleagueId?: ColleagueId;
}): Promise<AgentCore> {
  const config = loadConfig();
  if (options.role === 'parent') {
    console.log(
      `[config] autoApproveAll=${config.autoApproveAll} provider=${config.llmProvider} voice=${config.voiceEnabled} tts=${config.voiceTtsEnabled}`,
    );
  }

  const searchRoots = resolveSearchRoots({
    configured: process.env.FILESYSTEM_SEARCH_ROOTS,
  });
  if (options.role === 'parent') {
    console.log(`[filesystem] search roots: ${searchRoots.join(', ')}`);
  }

  const memoryEmbedder = config.dashscope.apiKey
    ? createResilientEmbedder(
        createDashScopeEmbedder({ apiKey: config.dashscope.apiKey }),
        createLocalEmbedder(),
      )
    : createLocalEmbedder();

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

  if (options.role === 'parent' && sessionBackend === 'postgres') {
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

  const primaryLlm =
    config.llmProvider === 'openrouter'
      ? new OpenRouterProvider({
          apiKey: config.openrouter.apiKey,
          baseUrl: config.openrouter.baseUrl,
          model: config.openrouter.model,
          name: 'openrouter',
        })
      : config.llmProvider === 'deepseek'
        ? new OpenRouterProvider({
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

  const profileIngestor = new ProfileIngestor({
    llm,
    store: profileStore,
  });

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

  const { tools } = createBuiltinTools({
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
    if (tool.name === 'filesystem.delete') continue;
    toolRegistry.register(tool);
  }
  toolRegistry.register(createCodingTool());
  toolRegistry.register(createServerShellTool());
  toolRegistry.register(createSystemStatusTool());

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

  const isolation =
    options.role === 'worker'
      ? 'child'
      : colleagueForkEnabled()
        ? 'parent'
        : 'inprocess';
  const colleagueId =
    options.colleagueId ?? parseColleagueId(process.env.COLLEAGUE_ID ?? '') ?? undefined;

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
    isolation,
    ...(isolation === 'child' && colleagueId ? { workerColleagueId: colleagueId } : {}),
  });
  colleagueOffice.attachConversation(conversation);
  try {
    const ensured = await colleagueOffice.ensureSessions();
    const ids = [...ensured.entries()].map(([id, sessionId]) => `${id}=${sessionId.slice(0, 8)}`);
    const tag = options.role === 'worker' ? `worker:${colleagueId}` : 'parent';
    console.log(`[colleagues] ${tag} ensured ${ensured.size} session(s): ${ids.join(', ')}`);
  } catch (error) {
    console.warn(
      `[colleagues] ensureSessions failed (${error instanceof Error ? error.message : String(error)}), continuing without colleague sessions`,
    );
  }
  toolRegistry.register(createMailAskTool(colleagueOffice));
  toolRegistry.register(createMailSendTool(colleagueOffice));

  try {
    await colleagueOffice.hydrate();
  } catch (error) {
    console.warn(
      `[colleagues] hydrate failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  return {
    config,
    store,
    sessionBackend,
    memory,
    memoryBackend,
    taskStore,
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
    taskService,
    colleagueOffice,
    colleagueRunners,
    engineerTaskRunner,
    opsTaskRunner,
    designerTaskRunner,
    qaTaskRunner,
    researchTaskRunner,
    profileIngestor,
    searchRoots,
  };
}
