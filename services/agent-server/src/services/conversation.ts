import { randomUUID } from 'node:crypto';
import type {
  ChatInput,
  ChatChunk,
  LLMChatMessage,
  LLMTool,
  LLMToolCallWire,
  LLMProvider,
} from '@personal-ai/llm';
import type { ProfileStore, SessionStore, TimelineStore } from '@personal-ai/memory';
import type { MemoryStore } from '@personal-ai/memory';
import { createEnvelope } from '@personal-ai/protocol';
import type { ProtocolEnvelope } from '@personal-ai/protocol';
import type { ChatMessage, Session, TokenUsage, ToolCallInfo } from '@personal-ai/types';
import {
  GOAL_PREFIX,
  type ToolContext,
  type ToolResult,
  type ToolRegistry,
} from '@personal-ai/tools';
import { approvalFingerprint, ApprovalRegistry } from './approval.js';
import { runToolCallWithApproval } from './tool-execution.js';
import { classifyToolFailure, FAILURE_CLASS_LABEL } from './failure-classifier.js';

export interface RunChatInput {
  sessionId: string;
  userMessage: string;
  requestId?: string;
  signal?: AbortSignal;
  /** Unattended execution (scheduled tasks): L2/L3 tools are denied without prompting. */
  headless?: boolean;
  /** 允许使用的工具白名单（定时任务加固，OpenClaw tools-allow 思路）。 */
  toolAllowlist?: string[];
  /** 本次请求工具调用预算上限；超限即熔断（自主任务成本控制）。 */
  toolBudget?: number;
}

export interface ConversationServiceDeps {
  store: SessionStore;
  llm: LLMProvider;
  tools: ToolRegistry;
  approvals: ApprovalRegistry;
  memory: MemoryStore;
  /** 用户画像存储：注入"用户画像"上下文（结构化长期关系记忆）。 */
  profile?: ProfileStore;
  /** 事件时间线：记录/注入"我们之间发生过什么"。 */
  timeline?: TimelineStore;
  /** 对话正常结束后异步抽取画像（Mem0 两阶段思路）；不阻塞回复。 */
  profileIngest?: (userMessage: string) => void;
  /** 全权限模式：所有工具（含 L2/L3）自动执行，不弹确认。 */
  autoApproveAll?: boolean;
}

const MAX_TOOL_TURNS = 8;
const MEMORY_LIMIT = 3;
/** Message count that triggers context compaction (OpenClaw-style "compress first"). */
const COMPACTION_THRESHOLD = 60;
/** Most recent messages kept verbatim after compaction (must cover the last tool round). */
const KEEP_RECENT_MESSAGES = 24;

const MEMORY_PROMPT_PREFIX = '以下是关于用户的长期记忆（可能过时，如有冲突以用户当前的说法为准）：';
const GOAL_PROMPT_PREFIX = '以下是用户的长期目标（goal，请持续关注并在对话中主动推进）：';
const FEEDBACK_PROMPT_PREFIX = '以下是近期反馈与教训（[feedback]，请避免重蹈覆辙）：';
const PROFILE_PROMPT_PREFIX = '以下是用户画像（跨会话记住的用户事实/偏好/习惯，请主动贴合）：';
const TIMELINE_PROMPT_PREFIX = '以下是最近发生的事件时间线（供回忆上下文，按时间倒序）：';
const GOAL_CONTEXT_LIMIT = 5;
const FEEDBACK_CONTEXT_LIMIT = 3;
const PROFILE_CONTEXT_LIMIT = 30;
const TIMELINE_CONTEXT_LIMIT = 8;
const AUTO_APPROVE_PROMPT =
  '【当前为全权限模式】所有工具都会自动执行，无需用户确认。' +
  '即使工具描述里写着"需要确认"，也直接调用，不要询问或等待用户确认。';
/** 长任务派单工具：声称派单给小黑时必须真调用其一（程序硬校验）。 */
const LONG_TASK_TOOLS = ['engineer.delegate', 'coding.run'];
/** 声称"已派单/已开工"但实际没调工具时的检测模式（针对 bot 回复文字）。 */
const DISPATCH_CLAIM_PATTERN =
  /已派(给)?小黑|派出(给小黑)?|派给小黑|已派出去了|这就(派|开工)|正在派(给)?小黑|让小黑(去|来|分析|做|处理|搞)/;
/** 检测到假派单后注入的系统校验提示（强制下一轮真正调用工具）。 */
const DISPATCH_ENFORCE_PROMPT =
  '【系统校验】你刚才声称"已派单给小黑/已开始开发"，但本轮没有实际调用 ' +
  'engineer.delegate（派给小黑）或 coding.run（自我开发）工具。用户需要任务真正执行，' +
  '不要只输出文字。请立即调用对应工具完成派单；如你已经说过确认语，直接调用，不要重复说明。';
const COMPACTION_PROMPT = [
  '你是对话摘要助手。请把下面这段 AI 助理与用户的对话压缩成一份简洁的中文摘要，',
  '保留：用户的重要事实与偏好、已完成的任务和关键结果、尚未解决的事项。',
  '不要添加摘要之外的信息，不要使用 Markdown，200 字以内。',
].join('');

/** LLM 流式响应在多久没有新数据后视为卡死并中断（毫秒）。 */
const LLM_IDLE_TIMEOUT_MS = 90_000;
/** 首个 token 前出现瞬时错误（网络/429/5xx/超时）时的最大重试次数。 */
const LLM_RETRY_ATTEMPTS = 2;
const LLM_RETRY_BASE_DELAY_MS = 500;
/** 工具结果进入 LLM 上下文前的大小上限；超出后保留头尾并标注截断。 */
const TOOL_RESULT_MAX_CHARS = 8192;
const TOOL_RESULT_HEAD_CHARS = 4096;
const TOOL_RESULT_TAIL_CHARS = 1024;
/** 连续相同工具调用（同工具同参数）达到该次数即判定为循环并停止。 */
const TOOL_REPEAT_LIMIT = 3;

class LlmIdleTimeoutError extends Error {
  constructor(idleMs: number) {
    super(`LLM 响应超过 ${Math.round(idleMs / 1000)} 秒无新数据，已中断`);
    this.name = 'LlmIdleTimeoutError';
  }
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 判定错误是否值得重试：HTTP 429/5xx、网络层失败、连接中断、超时。
 * 配置错误等确定性失败不重试。
 */
function isRetryableLlmError(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (typeof status === 'number' && (status === 429 || status >= 500)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /network error|fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|timeout|aborted/i.test(
    message,
  );
}

/**
 * DeepSeek 等"思考模式"模型不接受 tool_choice 参数（400 invalid_request_error，
 * 如 "Thinking mode does not support this tool_choice"）。
 * 这类是确定性参数错误，重试相同请求无意义；应降级为不带 tool_choice 再试。
 */
function isToolChoiceUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /tool_choice/i.test(message) && /not support|unsupported|invalid/i.test(message);
}

/**
 * 给 LLM 流加上"无数据超时"与"首 token 前重试"：
 * - 超时：超过 idleTimeoutMs 没有任何 chunk 时中断本次尝试；
 * - 重试：仅在还没有产出任何 token 时重试（避免重复流内容），
 *   已产出内容后失败直接抛错，由上层转为 chat.error。
 * 用户取消（signal abort）永远不重试，保持原取消语义。
 */
async function* chatWithTimeoutAndRetry(
  llm: LLMProvider,
  input: ChatInput,
  options: { idleTimeoutMs?: number; retryAttempts?: number } = {},
): AsyncGenerator<ChatChunk, void, undefined> {
  const idleTimeoutMs = options.idleTimeoutMs ?? LLM_IDLE_TIMEOUT_MS;
  const retryAttempts = options.retryAttempts ?? LLM_RETRY_ATTEMPTS;
  /** 当前模型不支持 tool_choice 时降级一次（保留 messages 里的系统校验提示）。 */
  let degradedToolChoice = false;

  for (let attempt = 0; ; attempt++) {
    const request = degradedToolChoice ? { ...input, toolChoice: undefined } : input;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) {
      controller.abort(input.signal.reason);
    } else {
      input.signal?.addEventListener('abort', onAbort, { once: true });
    }

    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const armTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new LlmIdleTimeoutError(idleTimeoutMs));
      }, idleTimeoutMs);
      timer.unref?.();
    };
    armTimer();
    let gotChunk = false;

    try {
      for await (const chunk of llm.chat({ ...request, signal: controller.signal })) {
        gotChunk = true;
        armTimer();
        yield chunk;
      }
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      return;
    } catch (error) {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      if (input.signal?.aborted) throw error;
      // 思考模式不支持 tool_choice：降级重试（确定性参数错误，不计数到 retryAttempts）。
      if (input.toolChoice && !degradedToolChoice && isToolChoiceUnsupportedError(error)) {
        degradedToolChoice = true;
        continue;
      }
      if (!gotChunk && (timedOut || isRetryableLlmError(error)) && attempt < retryAttempts) {
        await delayMs(LLM_RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      throw timedOut ? new LlmIdleTimeoutError(idleTimeoutMs) : error;
    }
  }
}

/** 截断过大的工具结果：保留头部与尾部，中间标注省略，防止单条输出撑爆上下文。 */
export function pruneToolResult(content: string, maxChars = TOOL_RESULT_MAX_CHARS): string {
  if (content.length <= maxChars) return content;
  const head = content.slice(0, TOOL_RESULT_HEAD_CHARS);
  const tail = content.slice(-TOOL_RESULT_TAIL_CHARS);
  return `${head}\n…[结果过长已截断，原 ${content.length} 字符，仅保留头尾]…\n${tail}`;
}

/**
 * 持久上下文（Prime /goal + OpenCrabs 反馈台账思路）：把长期目标与近期
 * 反馈教训组装成一段系统提示注入每次对话，让 AI 跨会话持续关注目标、
 * 避免重复踩坑。目标与反馈都来自长期记忆，不引入新存储。
 */
export async function collectPersistentContext(
  memory: MemoryStore,
  profile?: ProfileStore,
  timeline?: TimelineStore,
): Promise<string | null> {
  const entries = await memory.list();
  // 优先按结构化 tag 过滤（写入方显式打标），旧数据（无 tag）回退到内容前缀匹配。
  const goals = entries
    .filter(
      (entry) =>
        entry.kind === 'semantic' &&
        (entry.tag === 'goal' || (!entry.tag && entry.content.startsWith(GOAL_PREFIX))),
    )
    .slice(0, GOAL_CONTEXT_LIMIT);
  const feedback = entries
    .filter(
      (entry) =>
        entry.kind === 'episodic' &&
        (entry.tag === 'feedback' || (!entry.tag && entry.content.startsWith('[feedback]'))),
    )
    .slice(0, FEEDBACK_CONTEXT_LIMIT);

  const blocks: string[] = [];
  if (goals.length > 0) {
    blocks.push(`${GOAL_PROMPT_PREFIX}\n${goals.map((entry) => `- ${entry.content}`).join('\n')}`);
  }
  if (feedback.length > 0) {
    blocks.push(
      `${FEEDBACK_PROMPT_PREFIX}\n${feedback.map((entry) => `- ${entry.content}`).join('\n')}`,
    );
  }
  if (profile) {
    const userProfile = await profile.getProfile('default');
    const profileEntries = userProfile?.entries ?? [];
    if (profileEntries.length > 0) {
      blocks.push(
        `${PROFILE_PROMPT_PREFIX}\n${profileEntries
          .slice(0, PROFILE_CONTEXT_LIMIT)
          .map((entry) => `- [${entry.category}] ${entry.key}：${entry.value}`)
          .join('\n')}`,
      );
    }
  }
  if (timeline) {
    const events = await timeline.listEvents({ limit: TIMELINE_CONTEXT_LIMIT });
    if (events.length > 0) {
      blocks.push(
        `${TIMELINE_PROMPT_PREFIX}\n${events
          .map((event) => `- [${event.type}] ${event.createdAt.slice(0, 16)} ${event.summary}`)
          .join('\n')}`,
      );
    }
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

/** Maps stored ChatMessage history into the LLM wire format (skips system rows). */
function toLLMMessages(history: ChatMessage[]): LLMChatMessage[] {
  const messages: LLMChatMessage[] = [];
  for (const message of history) {
    if (message.role === 'system') continue;
    const hasToolCalls = message.toolCalls !== undefined && message.toolCalls.length > 0;
    messages.push({
      role: message.role,
      // xAI / some providers reject assistant messages that combine text
      // content with tool_calls; keep the text in session history, but send
      // an empty content when replaying tool-call turns to the LLM.
      content: message.role === 'assistant' && hasToolCalls ? '' : message.content,
      ...(message.toolCalls ? { tool_calls: toLLMToolCalls(message.toolCalls) } : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    });
  }
  return messages;
}

/**
 * 修复会话历史里的工具调用配对（服务中断/并发写入残留），保证发给 LLM 的
 * messages 中每个 assistant(tool_calls) 之后紧跟其 tool 响应：
 * 1. 配对错乱：assistant(tool_calls) 与它的 tool 响应之间被 user/assistant
 *    消息隔开（并发请求把用户消息插进了工具执行间隙）——把这类非 tool 消息
 *    延迟到该轮工具配对完成后再输出；
 * 2. 完全缺失：为每个悬空调用追加合成错误结果，让模型知道调用被中断；
 * 3. 孤儿 tool：assistant 已被压缩/丢失——直接丢弃，避免 API 拒绝。
 */
export function repairToolResultPairing(messages: LLMChatMessage[]): LLMChatMessage[] {
  const repaired: LLMChatMessage[] = [];
  const pendingIds = new Set<string>();
  const deferred: LLMChatMessage[] = [];

  const flushPending = (): void => {
    for (const id of pendingIds) {
      repaired.push({
        role: 'tool',
        content: '[缺失的工具结果：该工具调用被中断，未返回结果]',
        tool_call_id: id,
      });
    }
    pendingIds.clear();
    repaired.push(...deferred);
    deferred.length = 0;
  };

  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      // 上一条 assistant 的工具还没配对完就来了新的 assistant：
      // 说明前一轮工具结果确实缺失，先补丁再继续。
      if (pendingIds.size > 0) flushPending();
      repaired.push(message);
      for (const call of message.tool_calls) pendingIds.add(call.id);
    } else if (message.role === 'tool' && message.tool_call_id) {
      if (pendingIds.has(message.tool_call_id)) {
        repaired.push(message);
        pendingIds.delete(message.tool_call_id);
        if (pendingIds.size === 0) {
          repaired.push(...deferred);
          deferred.length = 0;
        }
      }
      // 孤儿 tool（找不到对应 assistant）：丢弃，避免 API 拒绝
    } else {
      // user / assistant（无 tool_calls）等：等当前工具轮配对完成再输出
      if (pendingIds.size > 0) {
        deferred.push(message);
      } else {
        repaired.push(message);
      }
    }
  }
  if (pendingIds.size > 0) flushPending();
  return repaired;
}

function buildMessages(
  session: Session,
  userMessage: string,
  autoApproveAll = false,
): LLMChatMessage[] {
  const messages: LLMChatMessage[] = [];
  if (autoApproveAll) messages.push({ role: 'system', content: AUTO_APPROVE_PROMPT });
  if (session.systemPrompt) {
    messages.push({ role: 'system', content: session.systemPrompt });
  }
  messages.push(...repairToolResultPairing(toLLMMessages(session.messages)));
  messages.push({ role: 'user', content: userMessage });
  return messages;
}

function parseToolCallArgs(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return json;
  }
}

function toLLMTools(registry: ToolRegistry): LLMTool[] {
  return registry.list().map((tool) => ({
    type: 'function' as const,
    function: {
      // DeepSeek/OpenRouter 等 OpenAI 兼容 API 要求工具名只含 [a-zA-Z0-9_-]，
      // 我们的工具名是 cloud.instance_status 这类带点号；发往 LLM 前统一
      // 转下划线，收到 tool_calls 后再还原（见 #runChatInner）。
      name: sanitizeToolName(tool.name),
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/**
 * OpenAI 兼容 API（DeepSeek 官方、OpenRouter、部分 DashScope 端点）对
 * tools[].function.name 强制校验 ^[a-zA-Z0-9_-]+$，点号会被 400 拒绝。
 * 把点号等非法字符统一替换为下划线。
 */
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class ConversationService {
  readonly #store: SessionStore;
  readonly #llm: LLMProvider;
  readonly #tools: ToolRegistry;
  readonly #approvals: ApprovalRegistry;
  readonly #memory: MemoryStore;
  readonly #profile?: ProfileStore;
  readonly #timeline?: TimelineStore;
  readonly #profileIngest?: (userMessage: string) => void;
  readonly #autoApproveAll: boolean;
  /** 会话级串行队列：同一会话的请求排队执行，防止并发写入错乱历史。 */
  readonly #sessionQueues = new Map<string, Promise<unknown>>();

  constructor(deps: ConversationServiceDeps) {
    this.#store = deps.store;
    this.#llm = deps.llm;
    this.#tools = deps.tools;
    this.#approvals = deps.approvals;
    this.#memory = deps.memory;
    this.#profile = deps.profile;
    this.#timeline = deps.timeline;
    this.#profileIngest = deps.profileIngest;
    this.#autoApproveAll = deps.autoApproveAll ?? false;
  }

  /**
   * 运行一次对话请求。任务级权限授权（requestId 作用域）在请求结束后清理，
   * 避免 "Allow once" 泄漏到下一次请求。同一会话的请求串行执行：用户在
   * 工具执行间隙发新消息时，新请求排队等上一轮（含工具结果）写完，避免
   * assistant(tool_calls) 与其 tool 响应之间被 user 消息隔开（DeepSeek 等
   * OpenAI 兼容 API 会因此拒绝请求）。
   */
  async *runChat(input: RunChatInput): AsyncIterable<ProtocolEnvelope> {
    const sessionId = input.sessionId;
    const previous = this.#sessionQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const myChain = previous.then(() => gate);
    this.#sessionQueues.set(sessionId, myChain);
    await previous;
    try {
      yield* this.#runChatInner(input);
    } finally {
      this.#approvals.clearForRequest(input.requestId);
      release();
      // 若队列里没有更晚的请求，移除条目避免 Map 无限增长
      if (this.#sessionQueues.get(sessionId) === myChain) {
        this.#sessionQueues.delete(sessionId);
      }
    }
  }

  async *#runChatInner(input: RunChatInput): AsyncIterable<ProtocolEnvelope> {
    const requestId = input.requestId ?? randomUUID();
    const requestStartedAt = Date.now();
    let session = await this.#store.getSession(input.sessionId);
    yield createEnvelope({
      type: 'agent.state',
      sessionId: input.sessionId,
      requestId,
      payload: { state: 'thinking' },
    });
    session = await this.#compactIfNeeded(session, input.signal);
    const messages = buildMessages(session, input.userMessage, this.#autoApproveAll);
    const tools = toLLMTools(this.#tools);
    // LLM 返回的是下划线化后的工具名，这里建反查表还原成注册表里的真名。
    const toolNameByWire = new Map(
      this.#tools
        .list()
        .map((tool) => [sanitizeToolName(tool.name), tool.name] as const),
    );
    const restoreToolName = (wireName: string): string => {
      if (this.#tools.has(wireName)) return wireName;
      return toolNameByWire.get(wireName) ?? wireName;
    };
    const [persistentContext, relevantMemories] = await Promise.all([
      collectPersistentContext(this.#memory, this.#profile, this.#timeline),
      this.#memory.search(input.userMessage, MEMORY_LIMIT),
    ]);
    let memoryInjected = false;
    let lastToolFingerprint: string | null = null;
    let toolRepeatCount = 0;
    let toolCallsUsed = 0;
    let toolBudgetExceeded = false;
    let stopToolLoop = false;
    /** 检测到"声称派单但未调工具"后，下一轮强制模型必须调用工具（tool_choice=required）。 */
    let dispatchRetryPending = false;

    await this.#store.addMessage(input.sessionId, {
      role: 'user',
      content: input.userMessage,
    });

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      let fullText = '';
      let usage: TokenUsage | undefined;
      let toolCalls: ToolCallInfo[] | undefined;

      // Idempotent: covers the initial turn and every follow-up after a tool
      // round (approval prompts switch the UI to awaiting_approval).
      yield createEnvelope({
        type: 'agent.state',
        sessionId: input.sessionId,
        requestId,
        payload: { state: 'thinking' },
      });

      const messagesForTurn: LLMChatMessage[] = (() => {
        if (memoryInjected) return messages;
        memoryInjected = true;
        const blocks: string[] = [];
        if (persistentContext) blocks.push(persistentContext);
        if (relevantMemories.length > 0) {
          const memoryText = relevantMemories.map(({ entry }) => `- ${entry.content}`).join('\n');
          blocks.push(`${MEMORY_PROMPT_PREFIX}\n${memoryText}`);
        }
        if (blocks.length === 0) return messages;
        return [{ role: 'system', content: blocks.join('\n\n') }, ...messages];
      })();

      const chatInput: ChatInput = {
        messages: messagesForTurn,
        ...(tools.length > 0 ? { tools } : {}),
        ...(dispatchRetryPending ? { toolChoice: 'required' as const } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      };
      dispatchRetryPending = false;

      try {
        for await (const chunk of chatWithTimeoutAndRetry(this.#llm, chatInput)) {
          if (chunk.delta.length > 0) {
            fullText += chunk.delta;
            yield createEnvelope({
              type: 'chat.token',
              sessionId: input.sessionId,
              requestId,
              payload: { delta: chunk.delta },
            });
          }
          if (chunk.usage) {
            usage = chunk.usage;
          }
          if (chunk.toolCalls && chunk.toolCalls.length > 0) {
            toolCalls = chunk.toolCalls.map((call) => ({
              ...call,
              name: restoreToolName(call.name),
            }));
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // 把失败写进历史，避免会话状态"悬空"；随后通知客户端并回到监听态。
        await this.#store.addMessage(input.sessionId, {
          role: 'assistant',
          content: `（回复生成失败：${detail}）`,
        });
        yield createEnvelope({
          type: 'chat.error',
          sessionId: input.sessionId,
          requestId,
          payload: { error: detail, durationMs: Date.now() - requestStartedAt },
        });
        yield createEnvelope({
          type: 'agent.state',
          sessionId: input.sessionId,
          requestId,
          payload: { state: 'listening' },
        });
        return;
      }

      // 派单硬校验（治"只说已派、实际没派"的反复事故）：
      // 模型文字声称"已派单/已开工"时，本轮必须真正调用派单工具
      // （engineer.delegate / coding.run）。
      // - 未调任何工具 → 注入系统提示强制补调；
      // - 只调了无关工具 → 同样拦截，防止"调个工具糊弄过去"。
      const claimedDispatch = !input.headless && DISPATCH_CLAIM_PATTERN.test(fullText);
      const dispatchedToBlack = (toolCalls ?? []).some((call) =>
        LONG_TASK_TOOLS.includes(call.name),
      );
      if (claimedDispatch && !dispatchedToBlack && turn < MAX_TOOL_TURNS - 1) {
        messages.push({ role: 'assistant', content: fullText });
        messages.push({ role: 'user', content: DISPATCH_ENFORCE_PROMPT });
        dispatchRetryPending = true;
        continue;
      }

      if (!toolCalls || toolCalls.length === 0) {
        // 推理模型偶发"只推理不出正文"：空回复时补一句，避免客户端静默无输出。
        const finalText =
          fullText.trim().length > 0
            ? fullText
            : '（本轮处理已完成，但未生成可见回复；如有需要请让我继续说明。）';
        await this.#store.addMessage(input.sessionId, {
          role: 'assistant',
          content: finalText,
        });
        yield createEnvelope({
          type: 'chat.done',
          sessionId: input.sessionId,
          requestId,
          payload: { text: finalText, usage, durationMs: Date.now() - requestStartedAt },
        });
        // 定时任务（headless）的 action 不是用户说的话，不参与画像/偏好抽取。
        if (!input.headless) {
          this.#profileIngest?.(input.userMessage);
        }
        // 定时任务（headless）由 task 事件留痕，不再重复写 chat 事件。
        if (!input.headless) {
          void this.#timeline?.addEvent({
            type: 'chat',
            summary: `和用户对话：${input.userMessage.trim().slice(0, 120)}`,
            sessionId: input.sessionId,
          });
        }
        yield createEnvelope({
          type: 'agent.state',
          sessionId: input.sessionId,
          requestId,
          payload: { state: 'listening' },
        });
        return;
      }

      await this.#store.addMessage(input.sessionId, {
        role: 'assistant',
        content: fullText,
        toolCalls,
      });
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: toLLMToolCalls(toolCalls),
      });

      yield createEnvelope({
        type: 'agent.tool_call',
        sessionId: input.sessionId,
        requestId,
        payload: { toolCalls },
      });

      for (const call of toolCalls) {
        toolCallsUsed += 1;
        const fingerprint = approvalFingerprint(call.name, parseToolCallArgs(call.arguments));
        if (fingerprint === lastToolFingerprint) {
          toolRepeatCount += 1;
        } else {
          lastToolFingerprint = fingerprint;
          toolRepeatCount = 1;
        }
        const context: ToolContext = {
          sessionId: input.sessionId,
          requestId: input.requestId,
          signal: input.signal,
        };
        let result: ToolResult | undefined;
        let toolStartedAt: number | undefined;
        if (input.toolBudget !== undefined && toolCallsUsed > input.toolBudget) {
          toolBudgetExceeded = true;
          stopToolLoop = true;
          result = {
            ok: false,
            error: `工具预算超限（已执行 ${toolCallsUsed - 1}/${input.toolBudget} 次），已熔断停止`,
          };
        } else if (input.toolAllowlist && !input.toolAllowlist.includes(call.name)) {
          // 定时任务工具白名单（OpenClaw tools-allow）：不在名单内直接拒绝，
          // 模型看到错误后可改用允许的工具。
          result = {
            ok: false,
            error: `工具 ${call.name} 不在该任务允许的工具白名单内（允许：${input.toolAllowlist.join(', ')}）`,
          };
        } else if (toolRepeatCount >= TOOL_REPEAT_LIMIT) {
          // 连续相同调用达到阈值：不再执行，直接返回错误结果并结束循环。
          stopToolLoop = true;
          result = {
            ok: false,
            error: `检测到连续 ${TOOL_REPEAT_LIMIT} 次调用相同工具（${call.name}，参数相同），疑似循环，已停止执行`,
          };
        } else {
          toolStartedAt = Date.now();
          const iterator = runToolCallWithApproval(
            this.#approvals,
            this.#tools,
            call,
            context,
            input.headless ?? false,
            this.#autoApproveAll,
          );
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              result = next.value;
              break;
            }
            yield next.value;
          }
        }
        if (result === undefined) {
          result = { ok: false, error: `工具 ${call.name} 执行异常` };
        }
        const failureLabel = result.ok
          ? null
          : classifyToolFailure(
              call.name,
              typeof result.error === 'string' ? result.error : '',
            );
        // OpenCrabs 思路：失败时给模型标注"可恢复 vs 缺陷"，避免把环境性
        // 失败沉淀成"禁用工具"的错误教训。
        const toolContent =
          pruneToolResult(JSON.stringify(result)) +
          (failureLabel ? `\n[失败分类] ${FAILURE_CLASS_LABEL[failureLabel]}` : '');
        const toolMessage: LLMChatMessage = {
          role: 'tool',
          content: toolContent,
          tool_call_id: call.id,
        };
        await this.#store.addMessage(input.sessionId, {
          role: 'tool',
          content: toolContent,
          toolCallId: call.id,
        });
        messages.push(toolMessage);

        yield createEnvelope({
          type: 'agent.tool_result',
          sessionId: input.sessionId,
          requestId,
          payload: {
            callId: call.id,
            name: call.name,
            result,
            ...(toolStartedAt !== undefined
              ? { durationMs: Date.now() - toolStartedAt }
              : {}),
          },
        });
      }

      if (stopToolLoop) {
        const note = toolBudgetExceeded
          ? `工具预算超限（已执行 ${toolCallsUsed} 次工具调用），已自动熔断停止`
          : `检测到工具循环（连续 ${TOOL_REPEAT_LIMIT} 次相同调用），已自动停止以避免无限执行`;
        await this.#store.addMessage(input.sessionId, {
          role: 'assistant',
          content: note,
        });
        void this.#timeline?.addEvent({
          type: 'chat',
          summary: `和用户对话（已停止）：${input.userMessage.trim().slice(0, 120)}`,
          sessionId: input.sessionId,
        });
        yield createEnvelope({
          type: 'chat.done',
          sessionId: input.sessionId,
          requestId,
          payload: { text: note, durationMs: Date.now() - requestStartedAt },
        });
        yield createEnvelope({
          type: 'agent.state',
          sessionId: input.sessionId,
          requestId,
          payload: { state: 'listening' },
        });
        return;
      }
    }

    // 工具轮次用尽：再跑一次不带工具的总结，避免多轮任务后收到空回复。
    let finalText = '';
    try {
      for await (const chunk of chatWithTimeoutAndRetry(this.#llm, {
        messages,
        ...(input.signal ? { signal: input.signal } : {}),
      })) {
        finalText += chunk.delta;
      }
    } catch (error) {
      finalText = `（工具轮次已达上限，最终总结生成失败：${error instanceof Error ? error.message : String(error)}）`;
    }
    const finalSummary =
      finalText.trim().length > 0
        ? finalText
        : '（本轮任务工具轮次已达上限，但未生成可见总结；如需结果请让我继续说明。）';
    await this.#store.addMessage(input.sessionId, {
      role: 'assistant',
      content: finalSummary,
    });
    void this.#timeline?.addEvent({
      type: 'chat',
      summary: `和用户对话（多轮工具任务）：${input.userMessage.trim().slice(0, 120)}`,
      sessionId: input.sessionId,
    });
    yield createEnvelope({
      type: 'chat.done',
      sessionId: input.sessionId,
      requestId,
      payload: {
        text: finalSummary,
        usage: undefined,
        note: `已执行 ${MAX_TOOL_TURNS} 轮工具，以上为最终总结`,
      },
    });
    yield createEnvelope({
      type: 'agent.state',
      sessionId: input.sessionId,
      requestId,
      payload: { state: 'listening' },
    });
  }

  /**
   * Context compaction: once a session passes COMPACTION_THRESHOLD messages,
   * summarize the older history into one message and trim the store. This keeps
   * prompts bounded (the full history used to be re-sent on every turn). The
   * compaction itself is one LLM call; failures degrade gracefully to the
   * existing behavior instead of breaking the conversation.
   */
  async #compactIfNeeded(session: Session, signal?: AbortSignal): Promise<Session> {
    if (session.messages.length <= COMPACTION_THRESHOLD) return session;
    if (session.metadata?.compacted === true) return session;

    const oldMessages = session.messages.slice(0, -KEEP_RECENT_MESSAGES);
    const recentMessages = session.messages.slice(-KEEP_RECENT_MESSAGES);
    if (oldMessages.length === 0) return session;

    try {
      let summary = '';
      const messagesForTurn: LLMChatMessage[] = [
        { role: 'system', content: COMPACTION_PROMPT },
        ...toLLMMessages(oldMessages),
      ];
      for await (const chunk of chatWithTimeoutAndRetry(this.#llm, {
        messages: messagesForTurn,
        ...(signal ? { signal } : {}),
      })) {
        summary += chunk.delta;
      }
      summary = summary.trim();
      const summaryMessage: ChatMessage = {
        id: randomUUID(),
        sessionId: session.id,
        role: 'user',
        content: summary ? `[历史对话摘要] ${summary}` : '[较早的对话未能生成摘要]',
        createdAt: new Date().toISOString(),
      };
      await this.#store.updateSession(session.id, {
        messages: [summaryMessage, ...recentMessages],
        metadata: {
          compacted: true,
          compactedAt: new Date().toISOString(),
          compactedCount: oldMessages.length,
        },
      });
      return this.#store.getSession(session.id);
    } catch (error) {
      console.warn(
        `[conversation] compaction skipped for ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return session;
    }
  }
}

/**
 * Converts the flat ToolCallInfo shape stored in sessions into the wire format
 * required by OpenAI-compatible APIs (tool_calls[].function.name/arguments).
 */
function toLLMToolCalls(calls: ToolCallInfo[]): LLMToolCallWire[] {
  return calls.map((call) => ({
    id: call.id,
    type: 'function' as const,
    function: {
      name: sanitizeToolName(call.name),
      arguments: call.arguments,
    },
  }));
}
