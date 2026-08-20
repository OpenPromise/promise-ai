import { randomUUID } from 'node:crypto';
import type {
  ChatInput,
  ChatChunk,
  LLMChatMessage,
  LLMTool,
  LLMToolCallWire,
  LLMProvider,
} from '@personal-ai/llm';
import type { ProfileStore, SessionStore } from '@personal-ai/memory';
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
}

export interface ConversationServiceDeps {
  store: SessionStore;
  llm: LLMProvider;
  tools: ToolRegistry;
  approvals: ApprovalRegistry;
  memory: MemoryStore;
  /** 用户画像存储：注入"用户画像"上下文（结构化长期关系记忆）。 */
  profile?: ProfileStore;
  /** 对话正常结束后异步抽取画像（Mem0 两阶段思路）；不阻塞回复。 */
  profileIngest?: (userMessage: string) => void;
  /** 全权限模式：所有工具（含 L2/L3）自动执行，不弹确认。 */
  autoApproveAll?: boolean;
}

const MAX_TOOL_TURNS = 5;
const MEMORY_LIMIT = 3;
/** Message count that triggers context compaction (OpenClaw-style "compress first"). */
const COMPACTION_THRESHOLD = 60;
/** Most recent messages kept verbatim after compaction (must cover the last tool round). */
const KEEP_RECENT_MESSAGES = 24;

const MEMORY_PROMPT_PREFIX = '以下是关于用户的长期记忆（可能过时，如有冲突以用户当前的说法为准）：';
const GOAL_PROMPT_PREFIX = '以下是用户的长期目标（goal，请持续关注并在对话中主动推进）：';
const FEEDBACK_PROMPT_PREFIX = '以下是近期反馈与教训（[feedback]，请避免重蹈覆辙）：';
const PROFILE_PROMPT_PREFIX = '以下是用户画像（跨会话记住的用户事实/偏好/习惯，请主动贴合）：';
const GOAL_CONTEXT_LIMIT = 5;
const FEEDBACK_CONTEXT_LIMIT = 3;
const PROFILE_CONTEXT_LIMIT = 30;
const AUTO_APPROVE_PROMPT =
  '【当前为全权限模式】所有工具都会自动执行，无需用户确认。' +
  '即使工具描述里写着"需要确认"，也直接调用，不要询问或等待用户确认。';
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

  for (let attempt = 0; ; attempt++) {
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
      for await (const chunk of llm.chat({ ...input, signal: controller.signal })) {
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
): Promise<string | null> {
  const entries = await memory.list();
  const goals = entries
    .filter((entry) => entry.kind === 'semantic' && entry.content.startsWith(GOAL_PREFIX))
    .slice(0, GOAL_CONTEXT_LIMIT);
  const feedback = entries
    .filter((entry) => entry.kind === 'episodic' && entry.content.startsWith('[feedback]'))
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
 * 补全"有 assistant tool_calls 但缺对应 tool result"的历史（服务中断/崩溃残留）：
 * 为每个悬空调用追加合成错误结果，避免 OpenAI 兼容接口因悬空 tool_call 拒绝请求，
 * 也防止模型把"未执行的调用"当作已执行。
 */
export function repairToolResultPairing(messages: LLMChatMessage[]): LLMChatMessage[] {
  const repaired: LLMChatMessage[] = [];
  const pendingIds = new Set<string>();
  for (const message of messages) {
    repaired.push(message);
    if (message.role === 'assistant' && message.tool_calls) {
      for (const call of message.tool_calls) {
        pendingIds.add(call.id);
      }
    } else if (message.role === 'tool' && message.tool_call_id) {
      pendingIds.delete(message.tool_call_id);
    }
  }
  for (const id of pendingIds) {
    repaired.push({
      role: 'tool',
      content: '[缺失的工具结果：该工具调用被中断，未返回结果]',
      tool_call_id: id,
    });
  }
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
  readonly #profileIngest?: (userMessage: string) => void;
  readonly #autoApproveAll: boolean;

  constructor(deps: ConversationServiceDeps) {
    this.#store = deps.store;
    this.#llm = deps.llm;
    this.#tools = deps.tools;
    this.#approvals = deps.approvals;
    this.#memory = deps.memory;
    this.#profile = deps.profile;
    this.#profileIngest = deps.profileIngest;
    this.#autoApproveAll = deps.autoApproveAll ?? false;
  }

  /**
   * 运行一次对话请求。任务级权限授权（requestId 作用域）在请求结束后清理，
   * 避免 "Allow once" 泄漏到下一次请求。
   */
  async *runChat(input: RunChatInput): AsyncIterable<ProtocolEnvelope> {
    try {
      yield* this.#runChatInner(input);
    } finally {
      this.#approvals.clearForRequest(input.requestId);
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
      collectPersistentContext(this.#memory, this.#profile),
      this.#memory.search(input.userMessage, MEMORY_LIMIT),
    ]);
    let memoryInjected = false;
    let lastToolFingerprint: string | null = null;
    let toolRepeatCount = 0;
    let stopToolLoop = false;

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
        ...(input.signal ? { signal: input.signal } : {}),
      };

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
        this.#profileIngest?.(input.userMessage);
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
        if (toolRepeatCount >= TOOL_REPEAT_LIMIT) {
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
        const note = `检测到工具循环（连续 ${TOOL_REPEAT_LIMIT} 次相同调用），已自动停止以避免无限执行`;
        await this.#store.addMessage(input.sessionId, {
          role: 'assistant',
          content: note,
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

    yield createEnvelope({
      type: 'chat.done',
      sessionId: input.sessionId,
      requestId,
      payload: {
        text: '',
        usage: undefined,
        note: `Reached the maximum of ${MAX_TOOL_TURNS} tool turns`,
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
