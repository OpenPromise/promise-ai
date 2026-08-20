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

/** 可替换资产类型：发型/发色、服装、配饰、整体风格。 */
export const ASSET_TYPES = ['hair', 'clothing', 'accessory', 'style'] as const;
export type AvatarAssetType = (typeof ASSET_TYPES)[number];

/** AI 设计的可替换资产 preset：参数化覆盖外观，Avatar 可在 preset 间切换。 */
export interface AvatarAsset {
  id: string;
  type: AvatarAssetType;
  name: string;
  description: string;
  /** 外观参数覆盖（键 ∈ APPEARANCE_PARAMS，值 0~1）。 */
  params: Partial<AvatarAppearance>;
  /** 程序生成的 SVG 预览（data URL）。 */
  preview: string;
  source: 'ai' | 'user' | 'seed';
  status: 'active' | 'archived';
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

/** 对外快照：固定数字基因 + 当前穿着的资产（Avatar 状态单一入口）。 */
export interface AvatarSnapshot {
  genome: AvatarGenome;
  activeAssets: AvatarAsset[];
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

/** 进化触发阈值（可配置，0~1）。 */
export const DEFAULT_EVOLVE_THRESHOLD = 0.5;

/**
 * EvolutionScore = PreferenceStrength × EvidenceCount × Consistency ×
 * TimeFactor × AIConfidence（用户计划 §7）。超过阈值才允许永久变化。
 */
export function computeEvolutionScore(
  preference: Pick<
    AvatarPreference,
    'confidence' | 'evidenceCount' | 'consistency' | 'source' | 'firstSeenAt'
  >,
  now = Date.now(),
): number {
  const strength = preference.confidence;
  const evidenceFactor = Math.min(1, preference.evidenceCount / 5);
  const consistency = preference.consistency;
  const days = Math.max(
    0,
    (now - new Date(preference.firstSeenAt).getTime()) / 86_400_000,
  );
  const timeFactor = Math.min(1, days / 3);
  const aiConfidence = preference.source === 'ai' ? 1 : 0.85;
  return strength * evidenceFactor * consistency * timeFactor * aiConfidence;
}

/** 偏好文本 → Avatar 参数方向的关键词映射（Phase 3 轻量，无需额外 LLM）。 */
const PREFERENCE_KEYWORD_MAP: Array<{ keywords: string[]; parameter: string; direction: 1 | -1 }> = [
  { keywords: ['蓝色', '蓝发', '深蓝', '天蓝'], parameter: 'hairColor', direction: 1 },
  { keywords: ['紫色', '紫发'], parameter: 'hairColor', direction: -1 },
  { keywords: ['粉色', '粉发', '可爱', '萌'], parameter: 'cuteStyle', direction: 1 },
  { keywords: ['科技', '赛博', '未来', '机械', '霓虹'], parameter: 'cyberStyle', direction: 1 },
  { keywords: ['极简', '简约', '简单', '干净', '冷淡'], parameter: 'minimalStyle', direction: 1 },
  { keywords: ['短发'], parameter: 'hairLength', direction: -1 },
  { keywords: ['长发'], parameter: 'hairLength', direction: 1 },
  { keywords: ['红色', '红衣'], parameter: 'clothingColor', direction: 1 },
  { keywords: ['青色', '绿色', '清新'], parameter: 'clothingColor', direction: -1 },
  { keywords: ['配饰', '饰品', '项链', '耳环'], parameter: 'accessoryLevel', direction: 1 },
];

export interface AvatarPreferenceHit {
  parameter: string;
  direction: 1 | -1;
}

/** 把一句偏好文本映射成 Avatar 参数方向（可多个命中）。 */
export function mapPreferenceToAvatar(text: string): AvatarPreferenceHit[] {
  const lower = text.toLowerCase();
  const hits: AvatarPreferenceHit[] = [];
  for (const { keywords, parameter, direction } of PREFERENCE_KEYWORD_MAP) {
    if (keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) {
      hits.push({ parameter, direction });
    }
  }
  return hits;
}

/** 校验资产参数：键必须是外观参数、值必须是 0~1 数字，至少一个。 */
export function validateAssetParams(
  params: unknown,
): { ok: true; params: Partial<AvatarAppearance> } | { ok: false; error: string } {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, error: 'params 必须是对象' };
  }
  const result: Partial<AvatarAppearance> = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (!APPEARANCE_PARAMS.includes(key as keyof AvatarAppearance)) {
      return { ok: false, error: `未知外观参数：${key}（允许：${APPEARANCE_PARAMS.join('/')}）` };
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      return { ok: false, error: `参数 ${key} 必须是 0~1 的数字` };
    }
    result[key as keyof AvatarAppearance] = value;
  }
  if (Object.keys(result).length === 0) {
    return { ok: false, error: 'params 至少需要一个外观参数' };
  }
  return { ok: true, params: result };
}

function hsl(hue: number, sat: number, light: number): string {
  return `hsl(${Math.round(hue)},${Math.round(sat * 100)}%,${Math.round(light * 100)}%)`;
}

/**
 * 程序生成资产 SVG 预览（data URL）：按类型画出发色/服装/配饰/风格色卡，
 * 让衣橱在没有真实 3D 贴图的情况下也有可视化。
 */
export function generateAssetPreview(type: AvatarAssetType, params: Partial<AvatarAppearance>): string {
  const a = { ...defaultAvatarGenome().appearance, ...params };
  const hairHue = 195 + a.hairColor * 135;
  const clothHue = 220 + a.clothingColor * 100;
  const cyber = a.cyberStyle;
  const cute = a.cuteStyle;
  const minimal = a.minimalStyle;
  let content = '';

  if (type === 'hair') {
    const length = a.hairLength; // 0 短 → 1 长
    const top = 26 + length * 8;
    const ry = 46 + length * 20;
    content =
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${hsl(hairHue, 0.72, 0.58)}"/>` +
      `<stop offset="1" stop-color="${hsl(hairHue, 0.7, 0.22)}"/>` +
      `</linearGradient></defs>` +
      `<rect width="120" height="120" rx="14" fill="#10141e"/>` +
      `<ellipse cx="60" cy="${top}" rx="44" ry="${ry}" fill="url(#g)"/>` +
      `<ellipse cx="60" cy="46" rx="30" ry="26" fill="#f2d9c4"/>`;
  } else if (type === 'clothing') {
    const style = a.clothingStyle;
    content =
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${hsl(clothHue, 0.72, 0.52)}"/>` +
      `<stop offset="1" stop-color="${hsl(clothHue, 0.75, 0.3)}"/>` +
      `</linearGradient></defs>` +
      `<rect width="120" height="120" rx="14" fill="#10141e"/>` +
      `<path d="M40 28 L80 28 L88 62 L72 92 L60 74 L48 92 L32 62 Z" fill="url(#g)"/>` +
      `<circle cx="48" cy="34" r="2.5" fill="#fff" opacity="0.8"/>` +
      `<circle cx="72" cy="34" r="2.5" fill="#fff" opacity="0.8"/>` +
      `<text x="60" y="108" font-size="9" fill="#9aa3b5" text-anchor="middle">style ${style.toFixed(2)}</text>`;
  } else if (type === 'accessory') {
    const level = Math.max(0.2, a.accessoryLevel);
    const dots: string[] = [];
    for (let i = 0; i < Math.round(2 + level * 7); i++) {
      const x = 20 + ((i * 37 + 11) % 80);
      const y = 20 + ((i * 53 + 17) % 80);
      dots.push(`<circle cx="${x}" cy="${y}" r="${2 + level * 1.5}" fill="${hsl(hairHue, 0.8, 0.7)}" opacity="0.9"/>`);
    }
    content =
      `<rect width="120" height="120" rx="14" fill="#10141e"/>` +
      `<path d="M60 30 l5 12 h-10 z" fill="#d7c48a"/>` +
      `<circle cx="60" cy="50" r="16" fill="none" stroke="#d7c48a" stroke-width="3"/>` +
      dots.join('') +
      `<text x="60" y="108" font-size="9" fill="#9aa3b5" text-anchor="middle">level ${level.toFixed(2)}</text>`;
  } else {
    // style：赛博(蓝) / 可爱(粉) / 极简(白灰) 混合
    const c1 = hsl(220 + cyber * 40, 0.65 + cute * 0.2, 0.45);
    const c2 = hsl(330 - cute * 60, 0.65, 0.55);
    const c3 = hsl(210, 0.08 + minimal * 0.05, 0.9 - minimal * 0.25);
    content =
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${c1}"/>` +
      `<stop offset="0.55" stop-color="${c2}"/>` +
      `<stop offset="1" stop-color="${c3}"/>` +
      `</linearGradient></defs>` +
      `<rect width="120" height="120" rx="14" fill="url(#g)"/>` +
      `<text x="60" y="62" font-size="11" fill="#fff" text-anchor="middle" opacity="0.85">cyber ${cyber.toFixed(2)}</text>` +
      `<text x="60" y="80" font-size="9" fill="#fff" text-anchor="middle" opacity="0.65">cute ${cute.toFixed(2)} · minimal ${minimal.toFixed(2)}</text>`;
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">${content}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * 有效外观 = 数字基因 + 当前穿着资产覆盖（同参数后者胜出）。
 * 资产顺序固定：hair → clothing → accessory → style。
 */
export function applyAssetOverrides(
  genome: AvatarGenome,
  assets: AvatarAsset[],
): AvatarGenome {
  const appearance = { ...genome.appearance };
  const sorted = [...assets].sort(
    (a, b) => ASSET_TYPES.indexOf(a.type) - ASSET_TYPES.indexOf(b.type),
  );
  for (const asset of sorted) {
    for (const [key, value] of Object.entries(asset.params)) {
      (appearance as unknown as Record<string, number>)[key] = value;
    }
  }
  return { ...genome, appearance };
}

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
  /** 状态快照：固定基因 + 当前穿着资产（Avatar 状态单一入口）。 */
  getSnapshot(): Promise<AvatarSnapshot>;
  listAssets(options?: { status?: 'active' | 'archived'; type?: AvatarAssetType }): Promise<AvatarAsset[]>;
  getAsset(id: string): Promise<AvatarAsset | null>;
  createAsset(input: {
    type: AvatarAssetType;
    name: string;
    description?: string;
    params: Partial<AvatarAppearance>;
    source?: 'ai' | 'user' | 'seed';
  }): Promise<AvatarAsset>;
  setAssetStatus(id: string, status: 'active' | 'archived'): Promise<AvatarAsset | null>;
  getActiveAssets(): Promise<AvatarAsset[]>;
  setActiveAsset(type: AvatarAssetType, assetId: string | null): Promise<AvatarAsset[]>;
  recordAssetUse(id: string): Promise<void>;
}

export class InMemoryAvatarStore implements AvatarStore {
  #genome = defaultAvatarGenome();
  readonly #preferences = new Map<string, AvatarPreference>();
  readonly #events: AvatarEvolutionEvent[] = [];
  readonly #assets = new Map<string, AvatarAsset>();
  readonly #activeAssets = new Map<AvatarAssetType, string>();

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

  async getSnapshot(): Promise<AvatarSnapshot> {
    return {
      genome: await this.getGenome(),
      activeAssets: await this.getActiveAssets(),
    };
  }

  async listAssets(options: { status?: 'active' | 'archived'; type?: AvatarAssetType } = {}): Promise<AvatarAsset[]> {
    return [...this.#assets.values()]
      .filter((asset) => (options.status ? asset.status === options.status : true))
      .filter((asset) => (options.type ? asset.type === options.type : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getAsset(id: string): Promise<AvatarAsset | null> {
    return this.#assets.get(id) ?? null;
  }

  async createAsset(input: {
    type: AvatarAssetType;
    name: string;
    description?: string;
    params: Partial<AvatarAppearance>;
    source?: 'ai' | 'user' | 'seed';
  }): Promise<AvatarAsset> {
    const now = new Date().toISOString();
    const asset: AvatarAsset = {
      id: randomUUID(),
      type: input.type,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      params: input.params,
      preview: generateAssetPreview(input.type, input.params),
      source: input.source ?? 'ai',
      status: 'active',
      usageCount: 0,
      lastUsedAt: null,
      createdAt: now,
    };
    this.#assets.set(asset.id, asset);
    return structuredClone(asset);
  }

  async setAssetStatus(id: string, status: 'active' | 'archived'): Promise<AvatarAsset | null> {
    const asset = this.#assets.get(id);
    if (!asset) return null;
    const next = { ...asset, status };
    this.#assets.set(id, next);
    if (status === 'archived') {
      for (const [type, assetId] of this.#activeAssets) {
        if (assetId === id) this.#activeAssets.delete(type);
      }
    }
    return structuredClone(next);
  }

  async getActiveAssets(): Promise<AvatarAsset[]> {
    const result: AvatarAsset[] = [];
    for (const type of ASSET_TYPES) {
      const assetId = this.#activeAssets.get(type);
      const asset = assetId ? this.#assets.get(assetId) : undefined;
      if (asset && asset.status === 'active') result.push(structuredClone(asset));
    }
    return result;
  }

  async setActiveAsset(type: AvatarAssetType, assetId: string | null): Promise<AvatarAsset[]> {
    if (assetId === null) {
      this.#activeAssets.delete(type);
    } else {
      const asset = this.#assets.get(assetId);
      if (!asset || asset.status !== 'active') {
        throw new Error(`资产不存在或已归档：${assetId}`);
      }
      if (asset.type !== type) {
        throw new Error(`资产类型不匹配：期望 ${type}，实际 ${asset.type}`);
      }
      this.#activeAssets.set(type, assetId);
    }
    return this.getActiveAssets();
  }

  async recordAssetUse(id: string): Promise<void> {
    const asset = this.#assets.get(id);
    if (!asset) return;
    this.#assets.set(id, {
      ...asset,
      usageCount: asset.usageCount + 1,
      lastUsedAt: new Date().toISOString(),
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
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS avatar_assets (
        id text PRIMARY KEY,
        type text NOT NULL,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        params jsonb NOT NULL,
        preview text NOT NULL DEFAULT '',
        source text NOT NULL DEFAULT 'ai',
        status text NOT NULL DEFAULT 'active',
        usage_count integer NOT NULL DEFAULT 0,
        last_used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS avatar_active_assets (
        type text PRIMARY KEY,
        asset_id text NOT NULL REFERENCES avatar_assets(id),
        applied_at timestamptz NOT NULL DEFAULT now()
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

  async getSnapshot(): Promise<AvatarSnapshot> {
    return {
      genome: await this.getGenome(),
      activeAssets: await this.getActiveAssets(),
    };
  }

  async listAssets(options: { status?: 'active' | 'archived'; type?: AvatarAssetType } = {}): Promise<AvatarAsset[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (options.status) {
      values.push(options.status);
      conditions.push(`status = $${values.length}`);
    }
    if (options.type) {
      values.push(options.type);
      conditions.push(`type = $${values.length}`);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.#pool.query<AssetRow>(
      `SELECT id, type, name, description, params, preview, source, status, usage_count, last_used_at, created_at
       FROM avatar_assets${where} ORDER BY created_at ASC`,
      values,
    );
    return result.rows.map(mapAssetRow);
  }

  async getAsset(id: string): Promise<AvatarAsset | null> {
    const result = await this.#pool.query<AssetRow>(
      `SELECT id, type, name, description, params, preview, source, status, usage_count, last_used_at, created_at
       FROM avatar_assets WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapAssetRow(result.rows[0]) : null;
  }

  async createAsset(input: {
    type: AvatarAssetType;
    name: string;
    description?: string;
    params: Partial<AvatarAppearance>;
    source?: 'ai' | 'user' | 'seed';
  }): Promise<AvatarAsset> {
    const id = randomUUID();
    const preview = generateAssetPreview(input.type, input.params);
    await this.#pool.query(
      `INSERT INTO avatar_assets (id, type, name, description, params, preview, source, status, usage_count)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'active', 0)`,
      [
        id,
        input.type,
        input.name.trim(),
        input.description?.trim() ?? '',
        JSON.stringify(input.params),
        preview,
        input.source ?? 'ai',
      ],
    );
    const asset = await this.getAsset(id);
    if (!asset) throw new Error('创建资产失败');
    return asset;
  }

  async setAssetStatus(id: string, status: 'active' | 'archived'): Promise<AvatarAsset | null> {
    await this.#pool.query(
      `UPDATE avatar_assets SET status = $2 WHERE id = $1`,
      [id, status],
    );
    if (status === 'archived') {
      await this.#pool.query(
        `DELETE FROM avatar_active_assets WHERE asset_id = $1`,
        [id],
      );
    }
    return this.getAsset(id);
  }

  async getActiveAssets(): Promise<AvatarAsset[]> {
    const result = await this.#pool.query<AssetRow>(
      `SELECT a.id, a.type, a.name, a.description, a.params, a.preview, a.source, a.status, a.usage_count, a.last_used_at, a.created_at
       FROM avatar_active_assets aa
       JOIN avatar_assets a ON a.id = aa.asset_id
       WHERE a.status = 'active'
       ORDER BY array_position(ARRAY['hair','clothing','accessory','style'], a.type)`,
    );
    return result.rows.map(mapAssetRow);
  }

  async setActiveAsset(type: AvatarAssetType, assetId: string | null): Promise<AvatarAsset[]> {
    if (assetId === null) {
      await this.#pool.query(`DELETE FROM avatar_active_assets WHERE type = $1`, [type]);
    } else {
      const asset = await this.getAsset(assetId);
      if (!asset || asset.status !== 'active') {
        throw new Error(`资产不存在或已归档：${assetId}`);
      }
      if (asset.type !== type) {
        throw new Error(`资产类型不匹配：期望 ${type}，实际 ${asset.type}`);
      }
      await this.#pool.query(
        `INSERT INTO avatar_active_assets (type, asset_id, applied_at) VALUES ($1, $2, now())
         ON CONFLICT (type) DO UPDATE SET asset_id = $2, applied_at = now()`,
        [type, assetId],
      );
    }
    return this.getActiveAssets();
  }

  async recordAssetUse(id: string): Promise<void> {
    await this.#pool.query(
      `UPDATE avatar_assets SET usage_count = usage_count + 1, last_used_at = now() WHERE id = $1`,
      [id],
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

interface AssetRow {
  id: string;
  type: string;
  name: string;
  description: string;
  params: unknown;
  preview: string;
  source: string;
  status: string;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
}

function mapAssetRow(row: AssetRow): AvatarAsset {
  return {
    id: row.id,
    type: row.type as AvatarAssetType,
    name: row.name,
    description: row.description,
    params: (row.params ?? {}) as Partial<AvatarAppearance>,
    preview: row.preview,
    source: row.source as AvatarAsset['source'],
    status: row.status as AvatarAsset['status'],
    usageCount: row.usage_count,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
