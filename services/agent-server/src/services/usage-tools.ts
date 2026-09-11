import type { UsageStore, UsageSummaryPeriod } from '@personal-ai/memory';
import type { Tool, ToolResult } from '@personal-ai/tools';

/**
 * Usage ledger 工具（薄切片）：
 * - usage.summary（L0）：最近 24h / 今日按同事与模型汇总 tokens（及可选成本）
 */

export interface UsageToolOptions {
  store: UsageStore;
}

const PERIODS: UsageSummaryPeriod[] = ['24h', 'today'];

export function createUsageTools(options: UsageToolOptions): Tool[] {
  const { store } = options;
  return [
    {
      name: 'usage.summary',
      description:
        '查看 LLM 用量汇总（只读 L0）：最近 24 小时或今日的调用次数、' +
        'input/output tokens，按同事（xiaoye/xiaohei/…）与模型分组。' +
        'DeepSeek 会附估算人民币成本；其它 provider 仅 tokens。' +
        '用于回答「今天花了多少 / 谁最耗 token」。',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: PERIODS,
            description: '时间窗：24h（默认）或 today（当日 0 点起）',
          },
        },
        required: [],
      },
      permissionLevel: 0,
      async execute(input: unknown): Promise<ToolResult> {
        const { period } = (input ?? {}) as { period?: UsageSummaryPeriod };
        const resolved =
          period && PERIODS.includes(period) ? period : ('24h' as UsageSummaryPeriod);
        const summary = await store.summary({ period: resolved });
        return {
          ok: true,
          data: {
            ...summary,
            note:
              summary.calls === 0
                ? '该时间窗还没有用量记录'
                : summary.costCny === undefined
                  ? '仅 tokens（当前模型无已知单价，未估成本）'
                  : 'costCny 为 DeepSeek 公开价估算，仅供参考',
          },
        };
      },
    },
  ];
}
