import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

/**
 * LLM usage ledger（薄账本）：每条真实 LLM 调用记一行。
 * 成本可选：已知 DeepSeek 公开单价时估 costCny，否则只记 tokens。
 */

export interface UsageRecord {
  id: string;
  sessionId?: string;
  /** xiaoye hub，或 xiaohei / xiaoyou / xiaomei / xiaozhen / xiaozhi */
  colleague: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  /** 估算人民币成本（元）；未知单价时缺省。 */
  costCny?: number;
  createdAt: string;
}

export interface RecordUsageInput {
  sessionId?: string;
  colleague: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costCny?: number;
  /** 测试可注入时间。 */
  createdAt?: string;
}

export type UsageSummaryPeriod = '24h' | 'today';

export interface UsageSummaryOptions {
  /** 默认 24h；today = 当日 00:00（本地/注入 now）起。 */
  period?: UsageSummaryPeriod;
  /** 测试注入时钟。 */
  now?: Date;
}

export interface UsageColleagueTotals {
  colleague: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCny?: number;
}

export interface UsageModelTotals {
  model: string;
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCny?: number;
}

export interface UsageSummary {
  period: UsageSummaryPeriod;
  since: string;
  until: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCny?: number;
  byColleague: UsageColleagueTotals[];
  byModel: UsageModelTotals[];
}

export interface UsageStore {
  record(input: RecordUsageInput): Promise<UsageRecord>;
  summary(options?: UsageSummaryOptions): Promise<UsageSummary>;
  close?(): Promise<void>;
}

/** DeepSeek 官方公开价（元 / 百万 tokens，缓存未命中近似）。未知模型返回 undefined。 */
export function estimateDeepSeekCostCny(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const normalized = model.trim().toLowerCase();
  // deepseek-chat / deepseek-v3 系；reasoner / r1 更贵
  let inputPerM: number | undefined;
  let outputPerM: number | undefined;
  if (
    normalized.includes('reasoner') ||
    normalized.includes('r1') ||
    normalized.includes('deepseek-reasoner')
  ) {
    inputPerM = 4;
    outputPerM = 16;
  } else if (
    normalized.includes('deepseek-chat') ||
    normalized.includes('deepseek-v3') ||
    normalized === 'deepseek-chat' ||
    /deepseek/.test(normalized)
  ) {
    inputPerM = 1;
    outputPerM = 2;
  }
  if (inputPerM === undefined || outputPerM === undefined) return undefined;
  const cost = (inputTokens / 1_000_000) * inputPerM + (outputTokens / 1_000_000) * outputPerM;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function resolveUsageCostCny(input: {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCny?: number;
}): number | undefined {
  if (input.costCny !== undefined) return input.costCny;
  if (input.provider.toLowerCase().includes('deepseek') || /deepseek/i.test(input.model)) {
    return estimateDeepSeekCostCny(input.model, input.inputTokens, input.outputTokens);
  }
  return undefined;
}

function periodBounds(period: UsageSummaryPeriod, now: Date): { since: Date; until: Date } {
  const until = now;
  if (period === 'today') {
    const since = new Date(now);
    since.setHours(0, 0, 0, 0);
    return { since, until };
  }
  return { since: new Date(now.getTime() - 24 * 60 * 60_000), until };
}

function aggregate(
  records: UsageRecord[],
  period: UsageSummaryPeriod,
  since: Date,
  until: Date,
): UsageSummary {
  const byColleagueMap = new Map<string, UsageColleagueTotals>();
  const byModelMap = new Map<string, UsageModelTotals>();
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costSum = 0;
  let hasCost = false;

  for (const row of records) {
    calls += 1;
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    if (row.costCny !== undefined) {
      costSum += row.costCny;
      hasCost = true;
    }

    const colleague = byColleagueMap.get(row.colleague) ?? {
      colleague: row.colleague,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    colleague.calls += 1;
    colleague.inputTokens += row.inputTokens;
    colleague.outputTokens += row.outputTokens;
    colleague.totalTokens += row.inputTokens + row.outputTokens;
    if (row.costCny !== undefined) {
      colleague.costCny = (colleague.costCny ?? 0) + row.costCny;
    }
    byColleagueMap.set(row.colleague, colleague);

    const modelKey = `${row.provider}::${row.model}`;
    const model = byModelMap.get(modelKey) ?? {
      model: row.model,
      provider: row.provider,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    model.calls += 1;
    model.inputTokens += row.inputTokens;
    model.outputTokens += row.outputTokens;
    model.totalTokens += row.inputTokens + row.outputTokens;
    if (row.costCny !== undefined) {
      model.costCny = (model.costCny ?? 0) + row.costCny;
    }
    byModelMap.set(modelKey, model);
  }

  const roundCost = (value: number | undefined): number | undefined =>
    value === undefined ? undefined : Math.round(value * 1_000_000) / 1_000_000;

  return {
    period,
    since: since.toISOString(),
    until: until.toISOString(),
    calls,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(hasCost ? { costCny: roundCost(costSum) } : {}),
    byColleague: [...byColleagueMap.values()]
      .map((row) => ({
        ...row,
        ...(row.costCny !== undefined ? { costCny: roundCost(row.costCny) } : {}),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
    byModel: [...byModelMap.values()]
      .map((row) => ({
        ...row,
        ...(row.costCny !== undefined ? { costCny: roundCost(row.costCny) } : {}),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
  };
}

export class InMemoryUsageStore implements UsageStore {
  readonly #records: UsageRecord[] = [];

  async record(input: RecordUsageInput): Promise<UsageRecord> {
    const costCny = resolveUsageCostCny(input);
    const record: UsageRecord = {
      id: randomUUID(),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      colleague: input.colleague,
      model: input.model,
      provider: input.provider,
      inputTokens: Math.max(0, Math.floor(input.inputTokens)),
      outputTokens: Math.max(0, Math.floor(input.outputTokens)),
      ...(costCny !== undefined ? { costCny } : {}),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.#records.push(record);
    return { ...record };
  }

  async summary(options: UsageSummaryOptions = {}): Promise<UsageSummary> {
    const period = options.period ?? '24h';
    const now = options.now ?? new Date();
    const { since, until } = periodBounds(period, now);
    const sinceMs = since.getTime();
    const untilMs = until.getTime();
    const filtered = this.#records.filter((row) => {
      const t = Date.parse(row.createdAt);
      return Number.isFinite(t) && t >= sinceMs && t <= untilMs;
    });
    return aggregate(filtered, period, since, until);
  }
}

export interface PostgresUsageStoreOptions {
  connectionString: string;
  pool?: pg.Pool;
}

interface UsageRow {
  id: string;
  session_id: string | null;
  colleague: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cost_cny: string | number | null;
  created_at: string | Date;
}

function toRecord(row: UsageRow): UsageRecord {
  const cost =
    row.cost_cny === null || row.cost_cny === undefined
      ? undefined
      : typeof row.cost_cny === 'number'
        ? row.cost_cny
        : Number(row.cost_cny);
  return {
    id: row.id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    colleague: row.colleague,
    model: row.model,
    provider: row.provider,
    inputTokens: Number(row.input_tokens) || 0,
    outputTokens: Number(row.output_tokens) || 0,
    ...(cost !== undefined && Number.isFinite(cost) ? { costCny: cost } : {}),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class PostgresUsageStore implements UsageStore {
  readonly #pool: pg.Pool;

  constructor(options: PostgresUsageStoreOptions) {
    this.#pool = options.pool ?? new Pool({ connectionString: options.connectionString, max: 5 });
  }

  async init(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS llm_usage (
        id uuid PRIMARY KEY,
        session_id uuid,
        colleague text NOT NULL,
        model text NOT NULL,
        provider text NOT NULL,
        input_tokens integer NOT NULL DEFAULT 0,
        output_tokens integer NOT NULL DEFAULT 0,
        cost_cny numeric,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.#pool.query(
      'CREATE INDEX IF NOT EXISTS llm_usage_created_idx ON llm_usage (created_at DESC)',
    );
    await this.#pool.query(
      'CREATE INDEX IF NOT EXISTS llm_usage_colleague_created_idx ON llm_usage (colleague, created_at DESC)',
    );
  }

  async record(input: RecordUsageInput): Promise<UsageRecord> {
    const id = randomUUID();
    const costCny = resolveUsageCostCny(input);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const inputTokens = Math.max(0, Math.floor(input.inputTokens));
    const outputTokens = Math.max(0, Math.floor(input.outputTokens));
    await this.#pool.query(
      `INSERT INTO llm_usage
        (id, session_id, colleague, model, provider, input_tokens, output_tokens, cost_cny, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        input.sessionId ?? null,
        input.colleague,
        input.model,
        input.provider,
        inputTokens,
        outputTokens,
        costCny ?? null,
        createdAt,
      ],
    );
    return {
      id,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      colleague: input.colleague,
      model: input.model,
      provider: input.provider,
      inputTokens,
      outputTokens,
      ...(costCny !== undefined ? { costCny } : {}),
      createdAt: new Date(createdAt).toISOString(),
    };
  }

  async summary(options: UsageSummaryOptions = {}): Promise<UsageSummary> {
    const period = options.period ?? '24h';
    const now = options.now ?? new Date();
    const { since, until } = periodBounds(period, now);
    const result = await this.#pool.query<UsageRow>(
      `SELECT id, session_id, colleague, model, provider, input_tokens, output_tokens, cost_cny, created_at
       FROM llm_usage
       WHERE created_at >= $1 AND created_at <= $2
       ORDER BY created_at DESC`,
      [since.toISOString(), until.toISOString()],
    );
    return aggregate(result.rows.map(toRecord), period, since, until);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
