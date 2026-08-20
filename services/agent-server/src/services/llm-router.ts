import type { ChatChunk, ChatInput, GenerateResult, LLMProvider } from '@personal-ai/llm';

/**
 * flash/pro 双速路由（90/10 哲学）：
 * 日常对话、简单问答、语音级联走快模型（deepseek-v4-flash，低延迟低成本）；
 * 只有"复杂任务"才切强模型（deepseek-v4-pro），用启发式分类决定，透明可测。
 *
 * 不引入额外 Manager/Orchestrator 抽象：只是把两个 LLMProvider 按规则
 * 转发，符合 AGENTS.md「新增抽象必须回答解决什么问题」——这里是
 * 用最便宜的成本拿到最合适的推理深度。
 */

/** 触发强模型的复杂度关键词（命中任意一个即视为复杂任务）。 */
const COMPLEX_KEYWORDS = [
  '开发',
  '重构',
  '设计',
  '架构',
  '方案',
  '分析',
  '调研',
  '调查',
  '排查',
  '调试',
  '修复',
  '实现',
  '编写',
  '写一个',
  '写一段',
  '修改',
  '优化',
  '性能',
  '评估',
  '迁移',
  '集成',
  '协议',
  '漏洞',
  '攻击',
  '安全',
  '测试',
  '用例',
  'review',
  'bug',
  '报错',
  '错误',
  '异常',
  '崩溃',
  '部署',
  'docker',
  'git',
  '数据库',
  'sql',
  '评审',
];

/** 超过该长度的用户消息直接视为复杂任务（长请求通常需要深度推理）。 */
const LONG_MESSAGE_CHARS = 300;

function lastUserMessage(input: ChatInput): string {
  for (let i = input.messages.length - 1; i >= 0; i--) {
    if (input.messages[i]?.role === 'user') return input.messages[i]?.content ?? '';
  }
  return '';
}

/** 判断一次请求是否需要切到 pro 强模型。 */
export function isComplexRequest(input: ChatInput): boolean {
  const message = lastUserMessage(input).toLowerCase();
  if (message.length >= LONG_MESSAGE_CHARS) return true;
  return COMPLEX_KEYWORDS.some((keyword) => message.includes(keyword.toLowerCase()));
}

export interface RoutedLLMProviderOptions {
  /** 快模型：日常对话、语音级联（deepseek-v4-flash）。 */
  fast: LLMProvider;
  /** 强模型：复杂任务（deepseek-v4-pro）。 */
  smart: LLMProvider;
  /** 自定义分类器；缺省用 isComplexRequest。 */
  classify?: (input: ChatInput) => boolean;
  /** 路由决策日志回调（调试/审计用）。 */
  onRoute?: (input: ChatInput, model: 'fast' | 'smart') => void;
}

/** 按请求复杂度在快/强模型间转发，保持 LLMProvider 接口不变。 */
export function createRoutedLLMProvider(
  options: RoutedLLMProviderOptions,
): LLMProvider {
  const { fast, smart } = options;
  const classify = options.classify ?? isComplexRequest;
  const name = `${fast.name}+${smart.name}`;
  const pick = (input: ChatInput): LLMProvider => {
    const useSmart = classify(input);
    options.onRoute?.(input, useSmart ? 'smart' : 'fast');
    return useSmart ? smart : fast;
  };

  return {
    name,
    model: `${fast.model}|${smart.model}`,
    configured: fast.configured || smart.configured,
    async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
      yield* pick(input).chat(input);
    },
    async generate(input: ChatInput): Promise<GenerateResult> {
      return pick(input).generate(input);
    },
  };
}
