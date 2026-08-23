import { createEnvelope, type ProtocolEnvelope } from '@personal-ai/protocol';
import type { ToolCallInfo } from '@personal-ai/types';
import {
  validateToolArgs,
  type Tool,
  type ToolContext,
  type ToolResult,
  type ToolRegistry,
} from '@personal-ai/tools';
import { approvalFingerprint, type ApprovalDecision, type ApprovalRegistry } from './approval.js';

export const TOOL_TIMEOUT_MS = 15_000;

/**
 * 配置缺失类错误的统一提示后缀（Leon resolveToolAvailability 思路的务实版）：
 * 报错即给指引——缺什么、去哪配、怎么补，让上层（LLM/用户）能直接引导配置，
 * 而不是盲试。用法：`工具 X 失败：...${missingConfigHint('DEEPSEEK_API_KEY', ...)}`。
 * 刻意不做完整 not_available 枚举（避免过度设计），只保证"报错信息自带修复路径"。
 */
export function missingConfigHint(
  missing: string,
  location: string,
  howToFix: string,
): string {
  return `（缺什么：${missing}；配置位置：${location}；如何补：${howToFix}）`;
}

export class ToolTimeoutError extends Error {
  constructor(toolName: string) {
    super(`工具 ${toolName} 执行超时，已终止`);
    this.name = 'ToolTimeoutError';
  }
}

/**
 * Runs one tool with a 15s timeout, turning timeouts and thrown errors into
 * failed ToolResults so the agent can explain or recover. The timeout is a
 * real race: tools that ignore the abort signal still get cut off.
 */
export async function runToolWithTimeout(
  tool: Tool,
  args: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  const timeoutMs = tool.timeoutMs ?? TOOL_TIMEOUT_MS;
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(context.signal?.reason);
  if (context.signal?.aborted) {
    onParentAbort();
  } else {
    context.signal?.addEventListener('abort', onParentAbort, { once: true });
  }

  let timer: NodeJS.Timeout | undefined;
  const execution = tool.execute(args, { ...context, signal: controller.signal }).then(
    (result) => ({ kind: 'result' as const, result }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new ToolTimeoutError(tool.name));
      resolve({ kind: 'timeout' });
    }, timeoutMs);
    timer.unref?.();
  });

  const winner = await Promise.race([execution, timeout]);
  if (winner.kind === 'result') {
    clearTimeout(timer);
    context.signal?.removeEventListener('abort', onParentAbort);
    return winner.result;
  }
  if (winner.kind === 'timeout') {
    clearTimeout(timer);
    context.signal?.removeEventListener('abort', onParentAbort);
    return { ok: false, error: `工具 ${tool.name} 执行超时，已终止` };
  }
  // The tool threw. Abort may already be set (parent cancel or our own timeout
  // race); prefer a clear message either way.
  clearTimeout(timer);
  context.signal?.removeEventListener('abort', onParentAbort);
  if (controller.signal.aborted) {
    return { ok: false, error: '工具执行被取消' };
  }
  return {
    ok: false,
    error: winner.error instanceof Error ? winner.error.message : String(winner.error),
  };
}

/**
 * Resolves one tool call, enforcing the permission system: L0/L1 run
 * immediately, L2/L3 wait for user approval (yielding permission envelopes).
 * Yields progress envelopes and returns the final ToolResult.
 */
export async function* runToolCallWithApproval(
  approvals: ApprovalRegistry,
  tools: ToolRegistry,
  call: ToolCallInfo,
  context: ToolContext,
  headless: boolean,
  autoApproveAll = false,
): AsyncGenerator<ProtocolEnvelope, ToolResult> {
  const tool = tools.get(call.name);
  if (!tool) {
    return { ok: false, error: `Tool not found: ${call.name}` };
  }

  let args: unknown;
  try {
    args = JSON.parse(call.arguments || '{}') as unknown;
  } catch (error) {
    return {
      ok: false,
      error: `工具参数不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Validate against the tool's JSON Schema before doing anything else so a
  // malformed call fails fast and the LLM can retry with correct arguments.
  const issues = validateToolArgs(tool.inputSchema, args);
  if (issues.length > 0) {
    return {
      ok: false,
      error: `工具 ${tool.name} 参数校验失败：${issues.map((issue) => issue.message).join('；')}`,
    };
  }

  // 全权限模式：所有等级工具直接执行（不弹确认，含无人值守任务）
  if (autoApproveAll || tool.permissionLevel <= 1) {
    return runToolWithTimeout(tool, args, context);
  }

  if (headless) {
    return {
      ok: false,
      error: `工具 ${tool.name} 需要用户确认，无人值守任务中不可用`,
    };
  }

  const level = tool.permissionLevel as 2 | 3;
  const fingerprint = approvalFingerprint(tool.name, args);
  // OpenDex 风格的任务级授权：本次请求已放行过该**参数指纹**（Allow once），
  // 后续同请求内相同参数的调用自动执行，直到请求结束（N4-P2-1）。
  if (level === 2 && approvals.isRequestApproved(context.requestId, fingerprint)) {
    return runToolWithTimeout(tool, args, context);
  }
  // L2: the user approved this exact call before in this session; run again
  // without re-prompting. L3 (power/terminal) always asks for fresh approval.
  if (level === 2 && approvals.isApproved(context.sessionId, fingerprint)) {
    return runToolWithTimeout(tool, args, context);
  }

  const confirmationsNeeded = level === 3 ? 2 : 1;
  let confirmationsDone = 0;

  while (confirmationsDone < confirmationsNeeded) {
    yield createEnvelope({
      type: 'agent.state',
      sessionId: context.sessionId,
      payload: { state: 'awaiting_approval' },
    });
    const { request, decision } = approvals.request({
      sessionId: context.sessionId,
      toolName: tool.name,
      arguments: args,
      permissionLevel: level,
      confirmationsNeeded,
      confirmationsDone,
    });

    yield createEnvelope({
      type: 'permission.request',
      sessionId: context.sessionId,
      payload: { request },
    });

    const approval: ApprovalDecision = await decision;
    yield createEnvelope({
      type: 'permission.response',
      sessionId: context.sessionId,
      payload: {
        requestId: request.requestId,
        approved: approval.approved,
        ...(approval.reason ? { reason: approval.reason } : {}),
      },
    });

    if (!approval.approved) {
      const reasonText =
        approval.reason === 'timeout'
          ? '确认超时'
          : approval.reason === 'session closed'
            ? '会话已关闭'
            : '用户拒绝';
      return {
        ok: false,
        error: `工具 ${tool.name} 未获批准（${reasonText}）`,
      };
    }
    confirmationsDone += 1;
  }

  approvals.rememberApproval(context.sessionId, fingerprint);
  approvals.rememberRequestApproval(context.requestId, context.sessionId, fingerprint);
  return runToolWithTimeout(tool, args, context);
}
