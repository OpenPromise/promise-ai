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

export interface ChatInput {
  messages: LLMChatMessage[];
  tools?: LLMTool[];
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
