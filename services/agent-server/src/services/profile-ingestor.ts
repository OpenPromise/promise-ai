import type { LLMProvider } from '@personal-ai/llm';
import type {
  ProfileCategory,
  ProfileEntry,
  ProfileStore,
  AvatarStore,
} from '@personal-ai/memory';
import { resolveProfileUserId } from '@personal-ai/memory';
import { mapPreferenceToAvatar } from '@personal-ai/memory';

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
  /** 画像超过该条数时自动触发整理（Letta memory pressure）。 */
  compactThreshold?: number;
  /** 两次自动整理的最小间隔（毫秒）。 */
  compactCooldownMs?: number;
  /** Avatar 偏好存储：抽取到的审美/外观偏好喂给进化引擎（user 源）。 */
  avatarStore?: AvatarStore;
}

/** 画像少于该条数时，整理直接跳过（不值得花一次 LLM）。 */
export const COMPACT_MIN_ENTRIES = 20;
/** 整理目标：合并后不超过该条数（与上下文注入上限对齐）。 */
export const COMPACT_TARGET = 30;

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

/** 画像整理 prompt（Letta memory pressure：合并重复/删陈旧/精简表述）。 */
export function buildCompactPrompt(
  entries: ProfileEntry[],
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        '你是用户画像整理员。现有用户画像条目过多，需要压缩整理：' +
        '1) 合并语义重复的条目（保留信息量最大的表述，key 取更通用的）；' +
        '2) 删除明显陈旧/自相矛盾的条目；3) 精简冗长表述；' +
        `4) 整理后总条数不超过 ${COMPACT_TARGET} 条。` +
        '保留真正有价值的用户事实/偏好/习惯/语气倾向，不要丢失重要信息。' +
        '只输出 JSON：{"facts":[{"key":"...","value":"...","category":"fact|preference|habit|tone"}]}',
    },
    {
      role: 'user',
      content: `当前用户画像（${entries.length} 条）：\n${entries
        .map((e) => `- [${e.category}] ${e.key}：${e.value}`)
        .join('\n')}\n\n请整理并输出 JSON。`,
    },
  ];
}

/**
 * 整理用户画像：合并/精简后整表替换。
 * 条目 ≤ COMPACT_MIN_ENTRIES 时跳过（返回 null，不浪费一次 LLM）。
 */
export async function compactProfile(
  store: ProfileStore,
  llm: LLMProvider,
  userId: string,
): Promise<{ before: number; after: number; removedKeys: string[] } | null> {
  const profile = await store.getProfile(userId);
  const entries = profile?.entries ?? [];
  if (entries.length <= COMPACT_MIN_ENTRIES) return null;

  const result = await llm.generate({ messages: buildCompactPrompt(entries) });
  const consolidated = parseExtractionResponse(result.text)
    .filter((fact) => fact.event !== 'DELETE')
    .slice(0, COMPACT_TARGET);
  if (consolidated.length === 0) return null;

  const beforeKeys = new Set(entries.map((e) => e.key));
  const afterKeys = new Set(consolidated.map((e) => e.key));
  await store.replaceAll(
    userId,
    consolidated.map(({ key, value, category }) => ({ key, value, category })),
  );
  return {
    before: entries.length,
    after: consolidated.length,
    removedKeys: [...beforeKeys].filter((key) => !afterKeys.has(key)),
  };
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
  readonly #compactThreshold: number;
  readonly #compactCooldownMs: number;
  readonly #avatarStore?: AvatarStore;
  #lastRunAt = 0;
  #lastCompactAt = 0;

  constructor(options: ProfileIngestorOptions) {
    this.#llm = options.llm;
    this.#store = options.store;
    this.#minIntervalMs = options.minIntervalMs ?? 10 * 60 * 1000;
    this.#compactThreshold = options.compactThreshold ?? 50;
    this.#compactCooldownMs = options.compactCooldownMs ?? 30 * 60 * 1000;
    this.#avatarStore = options.avatarStore;
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
      console.log(`[profile] ingest start: ${userMessage.trim().slice(0, 60)}`);
      const userId = resolveProfileUserId();
      const profile = await this.#store.getProfile(userId);
      const result = await this.#llm.generate({
        messages: buildExtractionPrompt(profile?.entries ?? [], userMessage.trim()),
      });
      // 无论是否抽到内容都记下时间，避免"无事实可抽"时每条消息都调 LLM。
      this.#lastRunAt = Date.now();
      const facts = parseExtractionResponse(result.text);
      console.log(`[profile] extraction facts: ${facts.length}`);
      if (facts.length === 0) return;
      const { applied } = await applyExtractedFacts(this.#store, userId, facts);
      console.log(`[profile] applyExtractedFacts applied=${applied}`);
      if (applied > 0) {
        console.log(`[profile] 对话后自动抽取：应用 ${applied} 条画像更新`);
      }
      // Avatar 进化证据：偏好类事实映射到外观参数，喂给 avatar_preferences（user 源）。
      if (this.#avatarStore) {
        let avatarHits = 0;
        for (const fact of facts) {
          if (fact.event === 'DELETE' || fact.event === 'NONE') continue;
          const hits = mapPreferenceToAvatar(`${fact.key} ${fact.value}`);
          for (const hit of hits) {
            avatarHits += 1;
            await this.#avatarStore.addPreferenceEvidence({
              parameter: hit.parameter,
              direction: hit.direction,
              source: 'user',
              confidence: 0.3,
              consistency: 1,
            });
          }
        }
        if (avatarHits > 0) {
          console.log(`[profile] avatar 偏好证据 +${avatarHits}`);
        }
      }
      // Letta memory pressure：画像过多时自动整理（带冷却，失败静默）。
      const updated = await this.#store.getProfile(userId);
      console.log(`[profile] profile count=${updated?.entries.length ?? 0}`);
      const count = updated?.entries.length ?? 0;
      const now = Date.now();
      if (
        count > this.#compactThreshold &&
        now - this.#lastCompactAt >= this.#compactCooldownMs
      ) {
        this.#lastCompactAt = now;
        const compacted = await compactProfile(this.#store, this.#llm, userId);
        if (compacted) {
          console.log(
            `[profile] 自动整理画像：${compacted.before} → ${compacted.after} 条` +
              (compacted.removedKeys.length > 0
                ? `，移除 ${compacted.removedKeys.join('、')}`
                : ''),
          );
        }
      }
    } catch (error) {
      console.warn(
        `[profile] 自动抽取失败（静默）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
