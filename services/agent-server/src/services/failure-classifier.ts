/**
 * 失败分类器（OpenCrabs feedback_policy 思路）：
 * 区分「可恢复/环境性失败」与「工具真缺陷」，避免把超时、网络抖动、
 * 文件未就绪等环境问题沉淀成"禁用某个工具"的错误教训。
 */

export type FailureClass = 'recoverable' | 'defect' | 'unknown';

/** 可恢复失败特征：超时、网络瞬断、资源未就绪、用户取消、陈旧快照等。 */
const RECOVERABLE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /超时/i,
  /econnrefused/i,
  /econnreset/i,
  /enetunreach/i,
  /fetch failed/i,
  /rate limit/i,
  /429/i,
  /503/i,
  /aborted/i,
  /取消/i,
  /not ready/i,
  /no such file/i,
  /目录不存在/i,
  /stale/i,
  /may have changed/i,
  /占用/i,
  /稍后/i,
  /暂时/i,
  /重试/i,
];

/** 工具真缺陷特征：参数非法、类型/模式错误、实现错误等。 */
const DEFECT_PATTERNS = [
  /invalid/i,
  /非法/i,
  /schema/i,
  /not a function/i,
  /is not defined/i,
  /cannot read/i,
  /参数校验失败/i,
  /参数/i,
  /typeerror/i,
  /referenceerror/i,
];

export function classifyToolFailure(toolName: string, error: string): FailureClass {
  const e = error.toLowerCase();
  if (RECOVERABLE_PATTERNS.some((pattern) => pattern.test(e))) return 'recoverable';
  if (DEFECT_PATTERNS.some((pattern) => pattern.test(e))) return 'defect';
  return 'unknown';
}

export const FAILURE_CLASS_LABEL: Record<FailureClass, string> = {
  recoverable: '可恢复（环境/超时/资源未就绪，不作为工具缺陷）',
  defect: '工具/参数缺陷',
  unknown: '待人工判断',
};
