import type { AvatarStore } from '@personal-ai/memory';
import type { AvatarEvolutionEvent, AvatarGenome } from '@personal-ai/memory';
import {
  ASSET_TYPES,
  applyAvatarDelta,
  computeEvolutionScore,
  DEFAULT_EVOLVE_THRESHOLD,
  validateAssetParams,
} from '@personal-ai/memory';
import type { AvatarAssetType, AvatarSnapshot } from '@personal-ai/memory';
import type { Tool, ToolResult } from '@personal-ai/tools';

/**
 * Avatar 工具（用户计划 §13）：
 * - avatar.state（L0）：当前基因组
 * - avatar.history（L0）：成长史
 * - avatar.preferences（L0）：用户/AI 偏好（含置信度）
 * - avatar.propose_evolution（L1）：AI 只能提案，程序验证评分/阈值/渐变后应用
 * - avatar.auto_evolve（L1）：自动评估偏好并小步应用
 * - avatar.assets（L0）：衣橱（可替换资产列表 + 当前穿着）
 * - avatar.design_asset（L1）：AI 设计新资产 preset（程序校验参数）
 * - avatar.apply_asset（L1）：切换/穿上某个资产
 * - avatar.clear_asset（L1）：脱掉某类资产，恢复数字基因外观
 * 禁止 change_mesh / regenerate 类工具——LLM 永远不能直接改 3D。
 */

export interface AvatarToolOptions {
  store: AvatarStore;
  /** 进化触发阈值，默认 0.5（可配置）。 */
  evolveThreshold?: number;
  /** 每次应用后回调（广播给所有端）。 */
  onChange?: (snapshot: AvatarSnapshot) => void;
}

export function createAvatarTools(options: AvatarToolOptions): Tool[] {
  const { store } = options;
  const threshold = options.evolveThreshold ?? DEFAULT_EVOLVE_THRESHOLD;
  const onChange = options.onChange;

  return [
    {
      name: 'avatar.state',
      description:
        '查看当前 Avatar 数字基因（只读 L0）：identity（固定）+ appearance 参数 + personality + 进化统计。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      async execute(): Promise<ToolResult> {
        const genome = await store.getGenome();
        return { ok: true, data: genome };
      },
    },
    {
      name: 'avatar.history',
      description: '查看 Avatar 成长史（只读 L0）：每次参数变化的时间/旧值/新值/原因/置信度。',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', description: '返回条数，默认 20' } },
        required: [],
      },
      permissionLevel: 0,
      async execute(input: unknown): Promise<ToolResult> {
        const { limit } = (input ?? {}) as { limit?: number };
        const events = await store.listEvolutionEvents(
          Math.min(Math.max(1, Math.floor(limit ?? 20)), 100),
        );
        return { ok: true, data: { count: events.length, events } };
      },
    },
    {
      name: 'avatar.preferences',
      description:
        '查看 Avatar 偏好证据（只读 L0）：user 源（用户表达的审美偏好）与 ai 源（AI 自己的审美），' +
        '含置信度/证据数/一致性/首次出现时间。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      async execute(): Promise<ToolResult> {
        const preferences = await store.listPreferences();
        return { ok: true, data: { count: preferences.length, preferences } };
      },
    },
    {
      name: 'avatar.propose_evolution',
      description:
        '提议一次 Avatar 外观演化（L1）。LLM 只能提案，程序会验证：' +
        '1) 该方向的偏好证据是否足够（EvolutionScore ≥ 阈值）；' +
        '2) 变化量被钳制在 ±0.08（渐变原则）。' +
        '证据不足时返回当前得分与阈值，不应用任何变化。' +
        'source：user=用户偏好的体现，ai=AI 自己形成的审美。',
      inputSchema: {
        type: 'object',
        properties: {
          parameter: {
            type: 'string',
            description: '外观/人格参数，如 hairColor / cyberStyle / minimalStyle',
          },
          direction: {
            type: 'number',
            enum: [1, -1],
            description: '变化方向：1=增强该风格，-1=减弱',
          },
          reason: { type: 'string', maxLength: 200, description: '变化原因' },
          source: {
            type: 'string',
            enum: ['user', 'ai'],
            description: '证据来源：user=用户偏好，ai=AI 自身审美（默认 ai）',
          },
        },
        required: ['parameter', 'direction'],
      },
      permissionLevel: 1,
      async execute(input: unknown): Promise<ToolResult> {
        const { parameter, direction, reason, source = 'ai' } = (input ?? {}) as {
          parameter?: string;
          direction?: number;
          reason?: string;
          source?: 'user' | 'ai';
        };
        if (!parameter?.trim() || (direction !== 1 && direction !== -1)) {
          return { ok: false, error: '缺少 parameter 或 direction(1/-1)' };
        }
        const preferences = await store.listPreferences();
        const match = preferences.find(
          (pref) =>
            pref.parameter === parameter.trim() &&
            pref.direction === direction &&
            pref.source === source,
        );
        if (!match) {
          return {
            ok: false,
            error: `没有 ${source} 源「${parameter.trim()}」方向 ${direction > 0 ? '增强' : '减弱'} 的偏好证据，暂不演化`,
          };
        }
        const score = computeEvolutionScore(match);
        if (score < threshold) {
          return {
            ok: false,
            error:
              `演化证据不足：EvolutionScore=${score.toFixed(2)} < 阈值 ${threshold}（置信度 ${match.confidence.toFixed(2)}、证据 ${match.evidenceCount} 次）。继续积累偏好后再试。`,
          };
        }
        const genome = await store.getGenome();
        const applied = applyAvatarDelta(
          genome,
          parameter.trim(),
          direction * 0.08,
          reason?.trim() || `${source === 'ai' ? 'AI 自身审美' : '用户偏好'}长期稳定`,
          score,
          [match.id],
        );
        if (!applied) {
          return { ok: false, error: `未知参数：${parameter.trim()}` };
        }
        await store.saveGenome(applied.genome);
        await store.addEvolutionEvent(applied.event);
        onChange?.(await store.getSnapshot());
        return {
          ok: true,
          data: {
            applied: true,
            score,
            threshold,
            event: applied.event,
            genome: applied.genome,
          },
        };
      },
    },
    {
      name: 'avatar.auto_evolve',
      description:
        '自动评估所有偏好证据（L1，纯程序逻辑，无需 LLM）：对 EvolutionScore ≥ 阈值' +
        '的偏好自动小步应用（±0.08，渐变原则），写成长史并广播到所有端。' +
        '同一参数两个方向都达阈值时视为冲突跳过（留待继续积累）。' +
        '适合定时任务（每日回顾）里调用，实现"自动成长"。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 1,
      async execute(): Promise<ToolResult> {
        const preferences = await store.listPreferences();
        // 按参数聚合：每个参数选得分最高且达标的方向应用一次
        const best: Map<
          string,
          { direction: 1 | -1; score: number; preferenceId: string; reason: string }
        > = new Map();
        const conflict = new Set<string>();
        for (const pref of preferences) {
          const score = computeEvolutionScore(pref);
          if (score < threshold) continue;
          const existing = best.get(pref.parameter);
          if (existing && existing.direction !== pref.direction) {
            conflict.add(pref.parameter);
            continue;
          }
          if (!existing || score > existing.score) {
            best.set(pref.parameter, {
              direction: pref.direction,
              score,
              preferenceId: pref.id,
              reason:
                `${pref.source === 'ai' ? 'AI 自身审美' : '用户偏好'}长期稳定` +
                `（EvolutionScore ${score.toFixed(2)}，证据 ${pref.evidenceCount} 次）`,
            });
          }
        }

        const applied: AvatarEvolutionEvent[] = [];
        const skipped: Array<{ parameter: string; reason: string }> = [];
        let genome = await store.getGenome();
        for (const [parameter, entry] of best) {
          if (conflict.has(parameter)) {
            skipped.push({ parameter, reason: '两个方向证据都达标，方向冲突，暂不演化' });
            continue;
          }
          const result = applyAvatarDelta(
            genome,
            parameter,
            entry.direction * 0.08,
            entry.reason,
            entry.score,
            [entry.preferenceId],
          );
          if (!result) {
            skipped.push({ parameter, reason: '未知参数' });
            continue;
          }
          genome = result.genome;
          await store.saveGenome(genome);
          await store.addEvolutionEvent(result.event);
          applied.push(result.event);
          onChange?.(await store.getSnapshot());
        }
        return {
          ok: true,
          data: {
            evaluated: preferences.length,
            threshold,
            applied: applied.length,
            events: applied,
            skipped,
            genome,
          },
        };
      },
    },
    {
      name: 'avatar.assets',
      description:
        '查看 Avatar 衣橱（只读 L0）：所有可替换资产 preset（发型/服装/配饰/风格，' +
        'AI 设计的可换造型）+ 当前正在穿着的资产。切换用 avatar.apply_asset / avatar.clear_asset。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      async execute(): Promise<ToolResult> {
        const [assets, activeAssets] = await Promise.all([
          store.listAssets({ status: 'active' }),
          store.getActiveAssets(),
        ]);
        return { ok: true, data: { count: assets.length, assets, activeAssets } };
      },
    },
    {
      name: 'avatar.design_asset',
      description:
        '设计一件新资产（L1，可逆外观 preset，不修改数字基因）：' +
        'AI 给出名称/类型/外观参数覆盖（键必须是外观参数 hairColor/hairLength/hairStyle/eyeColor/' +
        'eyeSize/clothingStyle/clothingColor/cyberStyle/cuteStyle/minimalStyle/accessoryLevel，值 0~1），' +
        '程序校验后入库并自动生成预览图，资产默认 active。' +
        '设计完用 avatar.apply_asset 穿上；也可以重复设计多件组成衣橱。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 60, description: '资产名称，如「海盐蓝渐变发」' },
          type: {
            type: 'string',
            enum: [...ASSET_TYPES],
            description: '资产类型：hair=发型/发色、clothing=服装、accessory=配饰、style=整体风格',
          },
          description: { type: 'string', maxLength: 300, description: '设计说明（可选）' },
          params: {
            type: 'object',
            description:
              '外观参数覆盖，如 {"hairColor":0.85,"hairLength":0.7}；键必须是外观参数，值 0~1',
          },
          source: {
            type: 'string',
            enum: ['ai', 'user', 'seed'],
            description: '设计来源，默认 ai',
          },
        },
        required: ['name', 'type', 'params'],
      },
      permissionLevel: 1,
      async execute(input: unknown): Promise<ToolResult> {
        const { name, type, description, params, source } = (input ?? {}) as {
          name?: string;
          type?: AvatarAssetType;
          description?: string;
          params?: unknown;
          source?: 'ai' | 'user' | 'seed';
        };
        const assetName = name?.trim();
        if (!assetName) return { ok: false, error: '缺少 name（资产名称）' };
        if (!type || !ASSET_TYPES.includes(type)) {
          return { ok: false, error: `type 必须是 ${ASSET_TYPES.join('/')} 之一` };
        }
        const validated = validateAssetParams(params);
        if (!validated.ok) return { ok: false, error: validated.error };
        const asset = await store.createAsset({
          type,
          name: assetName,
          description,
          params: validated.params,
          source,
        });
        onChange?.(await store.getSnapshot());
        return {
          ok: true,
          data: {
            created: true,
            asset,
            hint: '已入库，用 avatar.apply_asset 穿上（assetId 见上）。',
          },
        };
      },
    },
    {
      name: 'avatar.apply_asset',
      description:
        '切换/穿上一件已设计的资产（L1，可逆）：该类型只保留这一件，恢复用 avatar.clear_asset。' +
        '资产是参数化外观覆盖（发型/服装/配饰/风格），不改数字基因，可随时换回。',
      inputSchema: {
        type: 'object',
        properties: {
          assetId: { type: 'string', description: '资产 id（avatar.assets 里查看）' },
        },
        required: ['assetId'],
      },
      permissionLevel: 1,
      async execute(input: unknown): Promise<ToolResult> {
        const { assetId } = (input ?? {}) as { assetId?: string };
        if (!assetId?.trim()) return { ok: false, error: '缺少 assetId' };
        const asset = await store.getAsset(assetId.trim());
        if (!asset) return { ok: false, error: `资产不存在：${assetId}` };
        if (asset.status !== 'active') {
          return { ok: false, error: `资产「${asset.name}」已归档，无法使用` };
        }
        await store.setActiveAsset(asset.type, asset.id);
        await store.recordAssetUse(asset.id);
        const snapshot = await store.getSnapshot();
        onChange?.(snapshot);
        return {
          ok: true,
          data: {
            applied: true,
            asset: { id: asset.id, name: asset.name, type: asset.type },
            activeAssets: snapshot.activeAssets,
          },
        };
      },
    },
    {
      name: 'avatar.clear_asset',
      description:
        '脱掉某类资产，恢复该类型为数字基因默认外观（L1，可逆）。' +
        'type：hair/clothing/accessory/style。',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: [...ASSET_TYPES],
            description: '要清除的资产类型',
          },
        },
        required: ['type'],
      },
      permissionLevel: 1,
      async execute(input: unknown): Promise<ToolResult> {
        const { type } = (input ?? {}) as { type?: AvatarAssetType };
        if (!type || !ASSET_TYPES.includes(type)) {
          return { ok: false, error: `type 必须是 ${ASSET_TYPES.join('/')} 之一` };
        }
        await store.setActiveAsset(type, null);
        const snapshot = await store.getSnapshot();
        onChange?.(snapshot);
        return {
          ok: true,
          data: { cleared: true, type, activeAssets: snapshot.activeAssets },
        };
      },
    },
  ];
}
