/**
 * 失败分类器（OpenCrabs feedback_policy 思路）：
 * 区分「可恢复/环境性失败」与「工具真缺陷」，避免把超时、网络抖动、
 * 限流等环境问题沉淀成"禁用某个工具"的错误教训。
 *
 * 两条设计原则（审计 P1-17）：
 * 1. **先判缺陷，后判可恢复**。中文错误消息里"请稍后重试"是万能后缀，
 *    真缺陷（参数非法、TypeError）也常带着它；可恢复先判会把确定性缺陷
 *    吃掉，自愈规则永远沉淀不下来。
 * 2. **可恢复只认结构化信号**（HTTP 5xx/429、ETIMEDOUT/ECONNRESET、
 *    AbortError、显式超时），不认自然语言措辞（"稍后/暂时/重试"）。
 */

export type FailureClass = 'recoverable' | 'defect' | 'unknown';

/**
 * 工具真缺陷特征：参数非法、类型/语法错误、路径不存在（模型传错路径）。
 * ENOENT / "目录不存在" 归这里——它几乎总是"模型给了错路径"，
 * 而不是文件稍后会自己出现。
 */
const DEFECT_PATTERNS = [
  /invalid/i,
  /非法/,
  /schema/i,
  /not a function/i,
  /is not defined/i,
  /cannot read/i,
  /typeerror/i,
  /referenceerror/i,
  /syntaxerror/i,
  /参数校验失败/,
  // 收紧后的"参数"判定：只有明确说参数有问题时才算缺陷，
  // 说明性文字（"参数 path 表示目录"）不再误判。
  /参数[^，。；]*(非法|缺少|无效|错误|不合法|不支持)/,
  /(缺少|缺失)必填参数/,
  // 路径类缺陷
  /no such file/i,
  /enoent/i,
  /目录不存在/,
  /文件不存在/,
  /路径不存在/,
];

/**
 * 可恢复失败特征：结构化的超时/网络/限流/取消/资源未就绪信号。
 * 刻意不含"稍后/暂时/重试"这类措辞——它们在中文错误里是万能后缀。
 */
const RECOVERABLE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /超时/,
  /etimedout/i,
  /econnrefused/i,
  /econnreset/i,
  /econnaborted/i,
  /enetunreach/i,
  /ehostunreach/i,
  /eai_again/i,
  /ebusy/i,
  /socket hang up/i,
  /fetch failed/i,
  /rate limit/i,
  // HTTP 服务端错误与限流（"HTTP 503" / "status 502" / 裸状态码）
  /\b(429|500|502|503|504)\b/,
  /aborterror/i,
  /aborted/i,
  // 框架自身的取消消息（tool-execution 的"工具执行被取消"）：
  // 被动语态限定，避免把"取消"两字当通用可恢复信号。
  /被取消/,
  /not ready/i,
  /stale/i,
  /may have changed/i,
];

export function classifyToolFailure(toolName: string, error: string): FailureClass {
  // 先判缺陷：确定性缺陷即使带着"请稍后重试"也必须被记成缺陷。
  if (DEFECT_PATTERNS.some((pattern) => pattern.test(error))) return 'defect';
  if (RECOVERABLE_PATTERNS.some((pattern) => pattern.test(error))) return 'recoverable';
  return 'unknown';
}

export const FAILURE_CLASS_LABEL: Record<FailureClass, string> = {
  recoverable: '可恢复（环境/超时/资源未就绪，不作为工具缺陷）',
  defect: '工具/参数缺陷',
  unknown: '待人工判断',
};
