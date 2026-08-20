import type { LLMProvider } from '@personal-ai/llm';
import type {
  ProfileCategory,
  ProfileEntry,
  ProfileStore,
} from '@personal-ai/memory';
import { resolveProfileUserId } from '@personal-ai/memory';

/**
 * 对话后自动抽取画像（Mem0 两阶段 infer 思路的落地）：
 * 每次对话正常结束后，异步用快模型（flash）从用户消息抽取值得长期记住的
 * 信息，并与现有画像对比做 ADD / UPDATE / DELETE / NONE 决策后写回。
 * 不阻塞回复、带节流、失败静默——让"记住用户"从靠模型自觉变成系统保证。
 */

export type ExtractionEvent = 'ADD' | 'UPDATE' | 'DELETE' | 'NONE';

export interface ExtractedFact {
  key: string;
  value: string;
  category: ProfileCategory;
  event: ExtractionEvent;
}

export interface ProfileIngestorOptions {
  llm: LLMProvider;
  store: ProfileStore;
  /** 两次抽取的最小间隔（毫秒），防止每条消息都调 LLM。 */
  minIntervalMs?: number;
}

/** 抽取 prompt：质量门 + 携带现有画像做更新决策（Mem0 两阶段合一）。 */
export function buildExtractionPrompt(
  existing: ProfileEntry[],
  userMessage: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  const existingText =
    existing.length > 0
      ? existing.map((e) => `- [${e.category}] ${e.key}：${e.value}`).join('\n')
      : '（暂无画像）';
  return [
    {
      role: 'system',
      content:
        '你是用户画像管理器。从用户的对话消息中提取值得长期记住的信息，' +
        '分类为：fact=事实、preference=偏好、habit=习惯、tone=语气倾向。' +
        '准则：只从用户消息提取（忽略寒暄与一次性陈述，如"今天天气不错"）；' +
        '保持用户语言（中文进中文）；key 简洁唯一（如 name/作息/口味）。' +
        '把新信息与现有画像对比，为每条输出事件：' +
        'ADD=新信息；UPDATE=与现有同 key 但内容不同（保留信息量更大的表述）；' +
        'DELETE=新消息明确否定/取代现有某条（给出要删的 key）；NONE=重复或无价值。' +
        '只输出 JSON：{"facts":[{"key":"...","value":"...","category":"fact|preference|habit|tone","event":"ADD|UPDATE|DELETE|NONE"}]}',
    },
    {
      role: 'user',
      content: `现有用户画像：\n${existingText}\n\n本次用户消息：\n${userMessage}\n\n请输出 JSON。`,
    },
  ];
}

/** 从 LLM 输出里稳健解析抽取结果（容忍代码块/多余文字）。 */
export function parseExtractionResponse(text: string): ExtractedFact[] {
  const cleaned = text
    .replace(/```(?:json)?/g, '')
    .replace(/```/g, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
      facts?: Array<{
        key?: string;
        value?: string;
        category?: string;
        event?: string;
      }>;
    };
    if (!Array.isArray(parsed.facts)) return [];
    const categories: ProfileCategory[] = ['fact', 'preference', 'habit', 'tone'];
    const events: ExtractionEvent[] = ['ADD', 'UPDATE', 'DELETE', 'NONE'];
    return parsed.facts
      .filter(
        (fact) =>
          typeof fact.key === 'string' &&
          fact.key.trim().length > 0 &&
          typeof fact.value === 'string' &&
          fact.value.trim().length > 0 &&
          (!fact.category || categories.includes(fact.category as ProfileCategory)) &&
          (!fact.event || events.includes(fact.event as ExtractionEvent)),
      )
      .map((fact) => ({
        key: fact.key!.trim().slice(0, 64),
        value: fact.value!.trim().slice(0, 500),
        category: (fact.category as ProfileCategory) || 'fact',
        event: (fact.event as ExtractionEvent) || 'ADD',
      }));
  } catch {
    return [];
  }
}

/** 把抽取结果应用到画像存储（ADD/UPDATE 覆盖写，DELETE 删除，NONE 跳过）。 */
export async function applyExtractedFacts(
  store: ProfileStore,
  userId: string,
  facts: ExtractedFact[],
): Promise<{ applied: number }> {
  let applied = 0;
  for (const fact of facts) {
    if (fact.event === 'NONE') continue;
    if (fact.event === 'DELETE') {
      await store.removeEntry(userId, fact.key);
      applied += 1;
      continue;
    }
    await store.upsertEntry(userId, {
      key: fact.key,
      value: fact.value,
      category: fact.category,
    });
    applied += 1;
  }
  return { applied };
}

export class ProfileIngestor {
  readonly #llm: LLMProvider;
  readonly #store: ProfileStore;
  readonly #minIntervalMs: number;
  #lastRunAt = 0;

  constructor(options: ProfileIngestorOptions) {
    this.#llm = options.llm;
    this.#store = options.store;
    this.#minIntervalMs = options.minIntervalMs ?? 10 * 60 * 1000;
  }

  /** 节流：距上次抽取不足 minIntervalMs 时跳过。 */
  canRun(now = Date.now()): boolean {
    return now - this.#lastRunAt >= this.#minIntervalMs;
  }

  /** 异步执行抽取+写回；任何失败都静默（不影响对话）。 */
  async ingest(userMessage: string): Promise<void> {
    if (!userMessage.trim()) return;
    if (!this.canRun()) return;
    try {
      const userId = resolveProfileUserId();
      const profile = await this.#store.getProfile(userId);
      const result = await this.#llm.generate({
        messages: buildExtractionPrompt(profile?.entries ?? [], userMessage.trim()),
      });
      // 无论是否抽到内容都记下时间，避免"无事实可抽"时每条消息都调 LLM。
      this.#lastRunAt = Date.now();
      const facts = parseExtractionResponse(result.text);
      if (facts.length === 0) return;
      const { applied } = await applyExtractedFacts(this.#store, userId, facts);
      if (applied > 0) {
        console.log(`[profile] 对话后自动抽取：应用 ${applied} 条画像更新`);
      }
    } catch (error) {
      console.warn(
        `[profile] 自动抽取失败（静默）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
