import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

/**
 * 可成长 Avatar 的数字基因存储（用户《可成长固定底模 3D Avatar》计划 Phase 2）：
 * - avatar_genome：固定的 identity + 参数化 appearance/personality + 进化统计
 * - avatar_preferences：候选偏好（user/ai 双源）置信度积累
 * - avatar_evolution_events：成长史（"你为什么变成现在这样"）
 * 只允许小步渐变（applyAppearanceDelta 钳制），LLM 只能提案、程序应用。
 */

export interface AvatarIdentity {
  id: string;
  baseModel: string;
  version: number;
}

export interface AvatarAppearance {
  hairColor: number;
  hairLength: number;
  hairStyle: number;
  eyeColor: number;
  eyeSize: number;
  clothingStyle: number;
  clothingColor: number;
  cyberStyle: number;
  cuteStyle: number;
  minimalStyle: number;
  accessoryLevel: number;
}

export interface AvatarPersonality {
  calm: number;
  curiosity: number;
  playfulness: number;
  seriousness: number;
  confidence: number;
}

export interface AvatarGenome {
  identity: AvatarIdentity;
  appearance: AvatarAppearance;
  personality: AvatarPersonality;
  evolution: {
    generation: number;
    totalInteractions: number;
    lastEvolutionAt: string;
  };
}

export interface AvatarPreference {
  id: string;
  parameter: string;
  direction: 1 | -1;
  source: 'user' | 'ai';
  confidence: number;
  evidenceCount: number;
  consistency: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface AvatarEvolutionEvent {
  id: string;
  parameter: string;
  oldValue: number;
  newValue: number;
  reason: string;
  confidence: number;
  evidenceIds: string[];
  createdAt: string;
}

export function defaultAvatarGenome(): AvatarGenome {
  return {
    identity: {
      id: 'promise-ai',
      baseModel: 'base-avatar.vrm',
      version: 1,
    },
    appearance: {
      hairColor: 0.5,
      hairLength: 0.5,
      hairStyle: 0.5,
      eyeColor: 0.5,
      eyeSize: 0.5,
      clothingStyle: 0.5,
      clothingColor: 0.5,
      cyberStyle: 0.5,
      cuteStyle: 0.5,
      minimalStyle: 0.5,
      accessoryLevel: 0.5,
    },
    personality: {
      calm: 0.5,
      curiosity: 0.5,
      playfulness: 0.5,
      seriousness: 0.5,
      confidence: 0.5,
    },
    evolution: {
      generation: 0,
      totalInteractions: 0,
      lastEvolutionAt: new Date().toISOString(),
    },
  };
}

export const APPEARANCE_PARAMS = Object.keys(defaultAvatarGenome().appearance) as Array<
  keyof AvatarAppearance
>;
export const PERSONALITY_PARAMS = Object.keys(defaultAvatarGenome().personality) as Array<
  keyof AvatarPersonality
>;

/** 单次变化最大步长（渐变原则：禁止 0.2 → 1.0）。 */
export const MAX_EVOLUTION_DELTA = 0.08;

/**
 * 对 appearance/personality 参数应用小步增量（钳制步长与 0~1 范围）。
 * 返回新 genome 与旧值；参数非法返回 null。
 */
export function applyAvatarDelta(
  genome: AvatarGenome,
  parameter: string,
  delta: number,
  reason = 'evolution',
  confidence = 1,
  evidenceIds: string[] = [],
): { genome: AvatarGenome; event: AvatarEvolutionEvent } | null {
  let target: AvatarAppearance | AvatarPersonality;
  if (APPEARANCE_PARAMS.includes(parameter as keyof AvatarAppearance)) {
    target = { ...genome.appearance };
  } else if (PERSONALITY_PARAMS.includes(parameter as keyof AvatarPersonality)) {
    target = { ...genome.personality };
  } else {
    return null;
  }
  const oldValue = target[parameter as keyof typeof target] as number;
  const clampedDelta = Math.max(-MAX_EVOLUTION_DELTA, Math.min(MAX_EVOLUTION_DELTA, delta));
  const newValue = Math.max(0, Math.min(1, oldValue + clampedDelta));
  if (Math.abs(newValue - oldValue) < 0.001) return null;
  (target as unknown as Record<string, number>)[parameter] = newValue;
  const next: AvatarGenome = {
    ...genome,
    ...(APPEARANCE_PARAMS.includes(parameter as keyof AvatarAppearance)
      ? { appearance: target as AvatarAppearance }
      : { personality: target as AvatarPersonality }),
    evolution: {
      ...genome.evolution,
      generation: genome.evolution.generation + 1,
      lastEvolutionAt: new Date().toISOString(),
    },
  };
  return {
    genome: next,
    event: {
      id: randomUUID(),
      parameter,
      oldValue,
      newValue,
      reason,
      confidence,
      evidenceIds,
      createdAt: new Date().toISOString(),
    },
  };
}

export interface AvatarStore {
  getGenome(): Promise<AvatarGenome>;
  saveGenome(genome: AvatarGenome): Promise<AvatarGenome>;
  recordInteraction(): Promise<AvatarGenome>;
  listPreferences(): Promise<AvatarPreference[]>;
  addPreferenceEvidence(
    input: Omit<AvatarPreference, 'id' | 'firstSeenAt' | 'lastSeenAt' | 'evidenceCount'>,
  ): Promise<AvatarPreference[]>;
  listEvolutionEvents(limit?: number): Promise<AvatarEvolutionEvent[]>;
  addEvolutionEvent(event: Omit<AvatarEvolutionEvent, 'id' | 'createdAt'>): Promise<void>;
}

export class InMemoryAvatarStore implements AvatarStore {
  #genome = defaultAvatarGenome();
  readonly #preferences = new Map<string, AvatarPreference>();
  readonly #events: AvatarEvolutionEvent[] = [];

  async getGenome(): Promise<AvatarGenome> {
    return structuredClone(this.#genome);
  }

  async saveGenome(genome: AvatarGenome): Promise<AvatarGenome> {
    this.#genome = structuredClone(genome);
    return this.getGenome();
  }

  async recordInteraction(): Promise<AvatarGenome> {
    this.#genome.evolution.totalInteractions += 1;
    return this.getGenome();
  }

  async listPreferences(): Promise<AvatarPreference[]> {
    return [...this.#preferences.values()].sort((a, b) =>
      b.confidence - a.confidence,
    );
  }

  async addPreferenceEvidence(
    input: Omit<AvatarPreference, 'id' | 'firstSeenAt' | 'lastSeenAt' | 'evidenceCount'>,
  ): Promise<AvatarPreference[]> {
    const key = `${input.source}:${input.parameter}:${input.direction}`;
    const now = new Date().toISOString();
    const existing = this.#preferences.get(key);
    const evidenceCount = (existing?.evidenceCount ?? 0) + 1;
    const confidence = Math.min(1, (existing?.confidence ?? 0.3) + 0.08 * evidenceCount);
    const next: AvatarPreference = {
      id: existing?.id ?? randomUUID(),
      parameter: input.parameter,
      direction: input.direction,
      source: input.source,
      confidence,
      evidenceCount,
      consistency: input.consistency,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    this.#preferences.set(key, next);
    return this.listPreferences();
  }

  async listEvolutionEvents(limit = 50): Promise<AvatarEvolutionEvent[]> {
    return [...this.#events].slice(-limit).reverse();
  }

  async addEvolutionEvent(event: Omit<AvatarEvolutionEvent, 'id' | 'createdAt'>): Promise<void> {
    this.#events.push({
      ...event,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
  }
}

export interface PostgresAvatarStoreOptions {
  connectionString: string;
}

export class PostgresAvatarStore implements AvatarStore {
  readonly #pool: pg.Pool;

  constructor(options: PostgresAvatarStoreOptions) {
    this.#pool = new Pool({ connectionString: options.connectionString, max: 5 });
  }

  async init(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS avatar_genome (
        id text PRIMARY KEY,
        genome jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS avatar_preferences (
        id uuid PRIMARY KEY,
        parameter text NOT NULL,
        direction integer NOT NULL,
        source text NOT NULL,
        confidence double precision NOT NULL,
        evidence_count integer NOT NULL,
        consistency double precision NOT NULL,
        first_seen_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL
      )
    `);
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS avatar_evolution_events (
        id uuid PRIMARY KEY,
        parameter text NOT NULL,
        old_value double precision NOT NULL,
        new_value double precision NOT NULL,
        reason text NOT NULL,
        confidence double precision NOT NULL,
        evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async getGenome(): Promise<AvatarGenome> {
    const result = await this.#pool.query<{ genome: unknown }>(
      'SELECT genome FROM avatar_genome WHERE id = $1',
      ['default'],
    );
    if (!result.rows[0]) return defaultAvatarGenome();
    return result.rows[0].genome as AvatarGenome;
  }

  async saveGenome(genome: AvatarGenome): Promise<AvatarGenome> {
    await this.#pool.query(
      `INSERT INTO avatar_genome (id, genome, updated_at) VALUES ('default', $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET genome = $1::jsonb, updated_at = now()`,
      [JSON.stringify(genome)],
    );
    return genome;
  }

  async recordInteraction(): Promise<AvatarGenome> {
    const genome = await this.getGenome();
    genome.evolution.totalInteractions += 1;
    return this.saveGenome(genome);
  }

  async listPreferences(): Promise<AvatarPreference[]> {
    const result = await this.#pool.query<{
      id: string;
      parameter: string;
      direction: number;
      source: string;
      confidence: number;
      evidence_count: number;
      consistency: number;
      first_seen_at: string;
      last_seen_at: string;
    }>(
      'SELECT id, parameter, direction, source, confidence, evidence_count, consistency, first_seen_at, last_seen_at FROM avatar_preferences ORDER BY confidence DESC',
    );
    return result.rows.map((row) => ({
      id: row.id,
      parameter: row.parameter,
      direction: row.direction as 1 | -1,
      source: row.source as 'user' | 'ai',
      confidence: row.confidence,
      evidenceCount: row.evidence_count,
      consistency: row.consistency,
      firstSeenAt: new Date(row.first_seen_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
    }));
  }

  async addPreferenceEvidence(
    input: Omit<AvatarPreference, 'id' | 'firstSeenAt' | 'lastSeenAt' | 'evidenceCount'>,
  ): Promise<AvatarPreference[]> {
    const now = new Date();
    const existing = await this.#pool.query<{
      id: string;
      confidence: number;
      evidence_count: number;
      first_seen_at: string;
    }>(
      `SELECT id, confidence, evidence_count, first_seen_at FROM avatar_preferences
       WHERE parameter = $1 AND direction = $2 AND source = $3`,
      [input.parameter, input.direction, input.source],
    );
    const row = existing.rows[0];
    const evidenceCount = (row?.evidence_count ?? 0) + 1;
    const confidence = Math.min(1, (row?.confidence ?? 0.3) + 0.08 * evidenceCount);
    const firstSeen = row?.first_seen_at ?? now;
    await this.#pool.query(
      `INSERT INTO avatar_preferences (id, parameter, direction, source, confidence, evidence_count, consistency, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET confidence = $5, evidence_count = $6, consistency = $7, last_seen_at = $9`,
      [
        row?.id ?? randomUUID(),
        input.parameter,
        input.direction,
        input.source,
        confidence,
        evidenceCount,
        input.consistency,
        new Date(firstSeen).toISOString(),
        now.toISOString(),
      ],
    );
    return this.listPreferences();
  }

  async listEvolutionEvents(limit = 50): Promise<AvatarEvolutionEvent[]> {
    const result = await this.#pool.query<{
      id: string;
      parameter: string;
      old_value: number;
      new_value: number;
      reason: string;
      confidence: number;
      evidence_ids: unknown;
      created_at: string;
    }>(
      `SELECT id, parameter, old_value, new_value, reason, confidence, evidence_ids, created_at
       FROM avatar_evolution_events ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      parameter: row.parameter,
      oldValue: row.old_value,
      newValue: row.new_value,
      reason: row.reason,
      confidence: row.confidence,
      evidenceIds: Array.isArray(row.evidence_ids) ? (row.evidence_ids as string[]) : [],
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async addEvolutionEvent(event: Omit<AvatarEvolutionEvent, 'id' | 'createdAt'>): Promise<void> {
    await this.#pool.query(
      `INSERT INTO avatar_evolution_events (id, parameter, old_value, new_value, reason, confidence, evidence_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        randomUUID(),
        event.parameter,
        event.oldValue,
        event.newValue,
        event.reason,
        event.confidence,
        JSON.stringify(event.evidenceIds),
      ],
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
