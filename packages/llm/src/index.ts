import type { TokenUsage, ToolCallInfo } from '@personal-ai/types';

export type LLMRole = 'system' | 'user' | 'assistant' | 'tool';

/** Wire format for assistant tool_calls as sent to OpenAI-compatible APIs. */
export interface LLMToolCallWire {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMChatMessage {
  role: LLMRole;
  content: string;
  /** Wire field name required by OpenAI-compatible APIs. */
  tool_calls?: LLMToolCallWire[];
  tool_call_id?: string;
}

export interface LLMToolFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMTool {
  type: 'function';
  function: LLMToolFunction;
}

/**
 * 强制/约束模型是否调用工具（OpenAI 兼容 tool_choice）。
 * - 'auto'：模型自行决定（默认行为）
 * - 'required'：本轮必须调用某个工具（配合 guardrail 防止"声称派单却不调工具"）
 * - 'none'：禁用工具
 * - 指定函数：强制调用该工具
 */
export type ToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'function'; function: { name: string } };

export interface ChatInput {
  messages: LLMChatMessage[];
  tools?: LLMTool[];
  toolChoice?: ToolChoice;
  signal?: AbortSignal;
}

export interface ChatChunk {
  delta: string;
  finishReason?: string | null;
  usage?: TokenUsage;
  /** Complete list of tool calls when the model requests tool use */
  toolCalls?: ToolCallInfo[];
}

export interface GenerateResult {
  text: string;
  finishReason?: string | null;
  usage?: TokenUsage;
  toolCalls?: ToolCallInfo[];
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly configured: boolean;
  chat(input: ChatInput): AsyncIterable<ChatChunk>;
  generate(input: ChatInput): Promise<GenerateResult>;
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface RawToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface RawChatChoice {
  delta?: {
    content?: string;
    tool_calls?: RawToolCallDelta[];
  };
  message?: {
    content?: string;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
}

interface RawChatResponse {
  choices?: RawChatChoice[];
  usage?: RawUsage;
}

export function parseSseLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  return data.length > 0 ? data : null;
}

/**
 * Yields the raw `data:` payloads of an SSE stream from an OpenAI-compatible
 * chat completions endpoint. Shared by providers that speak this protocol
 * (e.g. OpenRouter, DashScope's compatible mode).
 */
export async function* iterSsePayloads(response: Response): AsyncGenerator<string> {
  if (!response.body) {
    throw new Error('Empty response body from chat completions stream');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const data = parseSseLine(line);
        if (data !== null) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function toTokenUsage(raw: RawUsage): TokenUsage {
  const inputTokens = raw.prompt_tokens ?? 0;
  const outputTokens = raw.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: raw.total_tokens ?? inputTokens + outputTokens,
  };
}

/**
 * Parses one SSE payload from an OpenAI-compatible chat completions stream.
 * Returns null when the payload carries no usable content, finish reason or
 * usage (e.g. keepalive or empty choice events).
 */
export function parseChatCompletionStreamData(data: string): {
  delta: string;
  finishReason?: string | null;
  usage?: TokenUsage;
  toolCallDeltas?: RawToolCallDelta[];
} | null {
  let json: RawChatResponse;
  try {
    json = JSON.parse(data) as RawChatResponse;
  } catch {
    return null;
  }

  const choice = json.choices?.[0];
  const delta = typeof choice?.delta?.content === 'string' ? choice.delta.content : '';
  const finishReason = choice?.finish_reason ?? undefined;
  const usage = json.usage ? toTokenUsage(json.usage) : undefined;
  const toolCallDeltas = choice?.delta?.tool_calls;

  if (
    delta.length === 0 &&
    finishReason === undefined &&
    usage === undefined &&
    (toolCallDeltas === undefined || toolCallDeltas.length === 0)
  ) {
    return null;
  }

  return {
    delta,
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(toolCallDeltas !== undefined && toolCallDeltas.length > 0 ? { toolCallDeltas } : {}),
  };
}

/**
 * Accumulates streamed tool-call deltas (indexed by OpenAI) into complete
 * tool calls. Arguments arrive as fragments and are concatenated per index.
 */
export function accumulateToolCalls(
  deltas: RawToolCallDelta[],
): Array<{ index: number; id?: string; name?: string; arguments?: string }> {
  return deltas.map((delta) => ({
    index: delta.index ?? 0,
    id: delta.id,
    name: delta.function?.name,
    arguments: delta.function?.arguments,
  }));
}

export function finalizeToolCalls(
  calls: Array<{ index: number; id?: string; name?: string; arguments?: string }>,
): ToolCallInfo[] {
  return calls
    .filter((call) => call.name)
    .map((call) => ({
      // Some providers (DashScope's OpenAI-compatible mode) stream tool calls
      // with an empty id; fall back so tool_call_id stays non-empty.
      id: call.id?.trim() ? call.id : `call_${call.index}`,
      name: call.name ?? '',
      arguments: call.arguments ?? '{}',
    }));
}

export interface FallbackLLMProviderOptions {
  primary: LLMProvider;
  /** 可选备用提供方；未配置时等同于直接使用 primary。 */
  fallback?: LLMProvider;
  /** 发生故障转移时回调（用于日志/事件上报）。 */
  onFailover?: (from: LLMProvider, to: LLMProvider, error: unknown) => void;
}

/**
 * OpenCrabs 式多后端故障转移：主模型在产出任何**可见文本**之前失败时，透明切换到
 * 备用提供方。判定基于"是否已 yield 过非空 delta"而不是"是否 yield 过 chunk"——
 * 首个 chunk 常是不含文本的 role/usage/tool_calls chunk，用它置位会让"实质上还没
 * 输出任何内容就失败"的情况失去切换机会，用户直接看到聊天失败。
 * 已经吐过内容之后中途失败无法回滚，直接抛给上层按既有错误路径处理。
 */
export class FallbackLLMProvider implements LLMProvider {
  readonly name = 'fallback';
  readonly model: string;
  readonly configured: boolean;
  readonly #primary: LLMProvider;
  readonly #fallback?: LLMProvider;
  readonly #onFailover?: (from: LLMProvider, to: LLMProvider, error: unknown) => void;

  constructor(options: FallbackLLMProviderOptions) {
    this.#primary = options.primary;
    this.#fallback = options.fallback;
    this.#onFailover = options.onFailover;
    this.model = this.#primary.model;
    this.configured = this.#primary.configured || Boolean(this.#fallback?.configured);
  }

  async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
    const iterator = this.#primary.chat(input)[Symbol.asyncIterator]();
    /** 是否已向上游产出过可见文本（空 delta 的 chunk 不算）。 */
    let producedText = false;
    try {
      while (true) {
        const { done, value } = await iterator.next();
        if (done) break;
        if (value.delta.length > 0) producedText = true;
        yield value;
      }
    } catch (error) {
      if (!producedText && this.#fallback) {
        this.#onFailover?.(this.#primary, this.#fallback, error);
        yield* this.#fallback.chat(input);
        return;
      }
      throw error;
    } finally {
      // 无条件释放主流：消费方提前 break（工具轮次、超时、abort）时不关闭迭代器
      // 会让底层 reader 与 HTTP 连接悬挂到 GC/服务端超时。已完成的迭代器上
      // return() 是幂等无害操作。
      await iterator.return?.();
    }
  }

  async generate(input: ChatInput): Promise<GenerateResult> {
    try {
      return await this.#primary.generate(input);
    } catch (error) {
      if (this.#fallback) {
        this.#onFailover?.(this.#primary, this.#fallback, error);
        return await this.#fallback.generate(input);
      }
      throw error;
    }
  }
}
