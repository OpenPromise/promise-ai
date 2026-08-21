import type { TokenUsage } from '@personal-ai/types';
import {
  iterSsePayloads,
  parseChatCompletionStreamData,
  accumulateToolCalls,
  finalizeToolCalls,
  type ChatChunk,
  type ChatInput,
  type GenerateResult,
  type LLMProvider,
} from '@personal-ai/llm';

export class OpenRouterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterConfigError';
  }
}

export class OpenRouterApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OpenRouterApiError';
    this.status = status;
  }
}

export interface OpenRouterProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  siteTitle?: string;
  /** 展示名（用于错误消息）：openrouter / deepseek / dashscope / grok… */
  name?: string;
}

/** 无 signal 请求的默认超时：画像抽取/记忆整理等 fire-and-forget 场景，防止永久挂起。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;

interface RawChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function toTokenUsage(raw: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): TokenUsage {
  const inputTokens = raw.prompt_tokens ?? 0;
  const outputTokens = raw.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: raw.total_tokens ?? inputTokens + outputTokens,
  };
}

export class OpenRouterProvider implements LLMProvider {
  readonly name: string;
  readonly configured: boolean;
  readonly model: string;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #siteTitle: string;

  constructor(options: OpenRouterProviderOptions = {}) {
    this.name = options.name ?? 'openrouter';
    this.#apiKey = options.apiKey?.trim() || undefined;
    this.configured = Boolean(this.#apiKey);
    this.model = options.model?.trim() || 'x-ai/grok-4.6';
    this.#baseUrl = (options.baseUrl?.trim() || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.#siteTitle = options.siteTitle?.trim() || 'personal-ai-assistant';
  }

  async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
    if (!this.#apiKey) {
      throw new OpenRouterConfigError(`${this.name} API key is not configured`);
    }

    const response = await this.#post(
      {
        model: this.model,
        messages: input.messages,
        ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
        ...(input.toolChoice ? { tool_choice: input.toolChoice } : {}),
        stream: true,
        stream_options: { include_usage: true },
      },
      input.signal,
    );

    const toolCallAccumulator = new Map<
      number,
      { index: number; id?: string; name?: string; arguments?: string }
    >();

    for await (const data of iterSsePayloads(response)) {
      if (data === '[DONE]') return;
      const chunk = parseChatCompletionStreamData(data);
      if (!chunk) continue;
      if (chunk.toolCallDeltas) {
        for (const delta of accumulateToolCalls(chunk.toolCallDeltas)) {
          const current = toolCallAccumulator.get(delta.index) ?? {
            index: delta.index,
            id: undefined,
            name: undefined,
            arguments: undefined,
          };
          toolCallAccumulator.set(delta.index, {
            index: delta.index,
            id: delta.id ?? current.id,
            name: delta.name ?? current.name,
            arguments: (current.arguments ?? '') + (delta.arguments ?? ''),
          });
        }
      }
      if (chunk.finishReason === 'tool_calls') {
        const toolCalls = finalizeToolCalls([...toolCallAccumulator.values()]);
        yield {
          delta: chunk.delta,
          finishReason: 'tool_calls',
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        };
        continue;
      }
      if (chunk.delta.length > 0 || chunk.usage) yield chunk;
    }
  }

  async generate(input: ChatInput): Promise<GenerateResult> {
    if (!this.#apiKey) {
      throw new OpenRouterConfigError(`${this.name} API key is not configured`);
    }

    const response = await this.#post(
      {
        model: this.model,
        messages: input.messages,
        ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
        ...(input.toolChoice ? { tool_choice: input.toolChoice } : {}),
        stream: false,
      },
      input.signal,
    );

    const json = (await response.json()) as RawChatResponse;
    const toolCalls = json.choices?.[0]?.message?.tool_calls;
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      finishReason: json.choices?.[0]?.finish_reason ?? null,
      ...(toolCalls && toolCalls.length > 0
        ? {
            toolCalls: toolCalls
              .filter((call) => call.function?.name)
              .map((call, index) => ({
                id: call.id ?? `call_${index}`,
                name: call.function?.name ?? '',
                arguments: call.function?.arguments ?? '{}',
              })),
          }
        : {}),
      ...(json.usage ? { usage: toTokenUsage(json.usage) } : {}),
    };
  }

  async #post(body: unknown, signal?: AbortSignal): Promise<Response> {
    if (!this.#apiKey) {
      throw new OpenRouterConfigError('OPENROUTER_API_KEY is not configured');
    }

    // 无 signal 的请求加默认超时（画像抽取/记忆整理等 fire-and-forget 场景），
    // 避免网络半开/上游不返回时 Promise 永不 settle。流式聊天自带 idle 超时
    // signal，传入即有值，不受默认超时影响；超时失败由调用方静默处理。
    const requestSignal = signal ?? AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.#apiKey}`,
          'X-Title': this.#siteTitle,
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch (error) {
      throw new OpenRouterApiError(
        `${this.name} network error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // ignore body read failure
      }
      throw new OpenRouterApiError(
        `${this.name} API error ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
        response.status,
      );
    }

    return response;
  }
}
