import type { AvatarStore } from '@personal-ai/memory';
import type { AvatarEvolutionEvent, AvatarGenome } from '@personal-ai/memory';
import {
  applyAvatarDelta,
  computeEvolutionScore,
  DEFAULT_EVOLVE_THRESHOLD,
} from '@personal-ai/memory';
import type { Tool, ToolResult } from '@personal-ai/tools';

/**
 * Avatar 工具（用户计划 §13）：
 * - avatar.state（L0）：当前基因组
 * - avatar.history（L0）：成长史
 * - avatar.preferences（L0）：用户/AI 偏好（含置信度）
 * - avatar.propose_evolution（L1）：AI 只能提案，程序验证评分/阈值/渐变后应用
 * 禁止 change_mesh / regenerate 类工具——LLM 永远不能直接改 3D。
 */

export interface AvatarToolOptions {
  store: AvatarStore;
  /** 进化触发阈值，默认 0.5（可配置）。 */
  evolveThreshold?: number;
  /** 每次应用后回调（广播给所有端）。 */
  onChange?: (genome: AvatarGenome) => void;
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
          onChange?.(genome);
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
  ];
}
