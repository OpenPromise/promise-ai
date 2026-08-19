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
}

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
  readonly name = 'openrouter';
  readonly configured: boolean;
  readonly model: string;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #siteTitle: string;

  constructor(options: OpenRouterProviderOptions = {}) {
    this.#apiKey = options.apiKey?.trim() || undefined;
    this.configured = Boolean(this.#apiKey);
    this.model = options.model?.trim() || 'x-ai/grok-4.6';
    this.#baseUrl = (options.baseUrl?.trim() || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.#siteTitle = options.siteTitle?.trim() || 'personal-ai-assistant';
  }

  async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
    if (!this.#apiKey) {
      throw new OpenRouterConfigError('OPENROUTER_API_KEY is not configured');
    }

    const response = await this.#post(
      {
        model: this.model,
        messages: input.messages,
        ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
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
      throw new OpenRouterConfigError('OPENROUTER_API_KEY is not configured');
    }

    const response = await this.#post(
      {
        model: this.model,
        messages: input.messages,
        ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
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
        signal,
      });
    } catch (error) {
      throw new OpenRouterApiError(
        `OpenRouter network error: ${error instanceof Error ? error.message : String(error)}`,
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
        `OpenRouter API error ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
        response.status,
      );
    }

    return response;
  }
}
