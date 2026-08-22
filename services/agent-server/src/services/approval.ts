import { randomUUID } from 'node:crypto';

/** #approved 指纹记忆的上限：会话数与每会话指纹数都封顶，防止长期运行无界增长。 */
const MAX_APPROVED_SESSIONS = 200;
const MAX_APPROVED_FINGERPRINTS = 100;
/**
 * 任务级授权（#requestApproved）的上限。
 * clearForRequest 只在正常收尾路径调用；chat 流被客户端中断、语音连接异常断开、
 * 进程内抛错等路径都会留下永久条目（N-P1-6），因此同样需要有界驱逐。
 */
const MAX_APPROVED_REQUESTS = 200;
const MAX_APPROVED_REQUEST_TOOLS = 100;

export interface ApprovalRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  arguments: unknown;
  permissionLevel: 2 | 3;
  confirmationsNeeded: number;
  confirmationsDone: number;
  createdAt: string;
  /**
   * 服务端判超时（自动拒绝）的时刻（ISO）。下游通道（微信 bridge 等）按它
   * 计时，不要自己猜一个窗口——两边窗口错配会让用户"明明回复了允许却没反应"。
   */
  expiresAt: string;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

/**
 * Stable serialization of tool arguments: object keys are sorted so the same
 * call produced with different key order still matches one fingerprint.
 */
export function approvalFingerprint(toolName: string, args: unknown): string {
  return `${toolName}:${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export interface ApprovalRegistryOptions {
  /** How long a permission request waits for the user before auto-denying. */
  timeoutMs?: number;
  /**
   * Whether an approved L2 call is remembered per session (same tool +
   * arguments auto-run next time, Mastra-style parameter fingerprinting).
   */
  rememberApprovals?: boolean;
}

/**
 * respond 结果：
 * - `resolved`：已作答；
 * - `not_found`：请求不存在或已过期（路由回 404）；
 * - `forbidden`：requestId 存在但属于别的会话（路由回 403），请求保持待处理。
 */
export type ApprovalRespondResult = 'resolved' | 'not_found' | 'forbidden';

/**
 * Tracks in-flight permission requests for L2/L3 tool calls. The agent loop
 * awaits the promise; the transport layer (SSE endpoint or voice WebSocket)
 * resolves it via {@link respond}. Requests auto-deny on timeout.
 */
export class ApprovalRegistry {
  readonly #pending = new Map<string, PendingApproval>();
  readonly #approved = new Map<string, Set<string>>();
  /** 任务级（单次请求）授权：requestId -> 已放行的工具名集合。 */
  readonly #requestApproved = new Map<string, Set<string>>();
  /** requestId → sessionId：会话关闭时按归属清理任务级授权（N4-P2-2）。 */
  readonly #requestSession = new Map<string, string>();
  readonly #timeoutMs: number;
  readonly #rememberApprovals: boolean;

  constructor(options: ApprovalRegistryOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#rememberApprovals = options.rememberApprovals ?? true;
  }

  request(input: {
    sessionId: string;
    toolName: string;
    arguments: unknown;
    permissionLevel: 2 | 3;
    confirmationsNeeded: number;
    confirmationsDone?: number;
  }): { request: ApprovalRequest; decision: Promise<ApprovalDecision> } {
    const createdAt = Date.now();
    const request: ApprovalRequest = {
      requestId: randomUUID(),
      sessionId: input.sessionId,
      toolName: input.toolName,
      arguments: input.arguments,
      permissionLevel: input.permissionLevel,
      confirmationsNeeded: input.confirmationsNeeded,
      confirmationsDone: input.confirmationsDone ?? 0,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + this.#timeoutMs).toISOString(),
    };

    const decision = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.requestId);
        resolve({ approved: false, reason: 'timeout' });
      }, this.#timeoutMs);
      timer.unref?.();

      this.#pending.set(request.requestId, { request, resolve, timer });
    });
    return { request, decision };
  }

  /**
   * Resolves a pending request.
   *
   * 传入 `sessionId` 时会断言归属（N-P0-3）：requestId 必须属于该会话，
   * 否则返回 `forbidden` 且请求保持待处理——防止第三方拿到别的会话的
   * requestId 就能替它点"允许"。语音通道等内部调用已在会话上下文内，
   * 可以不传。
   */
  respond(
    requestId: string,
    decision: ApprovalDecision,
    sessionId?: string,
  ): ApprovalRespondResult {
    const pending = this.#pending.get(requestId);
    if (!pending) return 'not_found';
    if (sessionId !== undefined && pending.request.sessionId !== sessionId) return 'forbidden';
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    return 'resolved';
  }

  listPending(sessionId: string): ApprovalRequest[] {
    return [...this.#pending.values()]
      .filter((entry) => entry.request.sessionId === sessionId)
      .map((entry) => entry.request);
  }

  /** Whether this exact tool call was already approved in the session. */
  isApproved(sessionId: string, fingerprint: string): boolean {
    return this.#approved.get(sessionId)?.has(fingerprint) ?? false;
  }

  /** 该请求（一次用户指令的多步工具循环）内该参数指纹是否已放行（N4-P2-1）。 */
  isRequestApproved(requestId: string | undefined, fingerprint: string): boolean {
    if (!requestId) return false;
    return this.#requestApproved.get(requestId)?.has(fingerprint) ?? false;
  }

  /**
   * 记住"Allow once"：本次请求后续对**相同参数指纹**的调用自动放行
   * （按指纹而非工具名，避免同名工具换参数被放大授权）。
   */
  rememberRequestApproval(
    requestId: string | undefined,
    sessionId: string,
    fingerprint: string,
  ): void {
    if (!requestId) return;
    // 有界驱逐（同 #approved 的做法）：异常路径漏掉 clearForRequest 时不至于泄漏。
    if (!this.#requestApproved.has(requestId) && this.#requestApproved.size >= MAX_APPROVED_REQUESTS) {
      const oldest = this.#requestApproved.keys().next().value;
      if (oldest !== undefined) this.#requestApproved.delete(oldest);
    }
    let fingerprints = this.#requestApproved.get(requestId);
    if (!fingerprints) {
      fingerprints = new Set();
      this.#requestApproved.set(requestId, fingerprints);
      this.#requestSession.set(requestId, sessionId);
    }
    if (fingerprints.size >= MAX_APPROVED_REQUEST_TOOLS) {
      const oldestFingerprint = fingerprints.keys().next().value;
      if (oldestFingerprint !== undefined) fingerprints.delete(oldestFingerprint);
    }
    fingerprints.add(fingerprint);
  }

  /** 请求结束（成功/失败/超轮数）后清理任务级授权，避免跨请求泄漏。 */
  clearForRequest(requestId: string | undefined): void {
    if (!requestId) return;
    this.#requestApproved.delete(requestId);
    this.#requestSession.delete(requestId);
  }

  /** Remembers an approved call so an identical one can auto-run. */
  rememberApproval(sessionId: string, fingerprint: string): void {
    if (!this.#rememberApprovals) return;
    // 有界驱逐：防止长期运行中 #approved 无限增长（每会话指纹数、会话总数都封顶）
    if (this.#approved.size >= MAX_APPROVED_SESSIONS) {
      const oldestSession = this.#approved.keys().next().value;
      if (oldestSession !== undefined) this.#approved.delete(oldestSession);
    }
    let fingerprints = this.#approved.get(sessionId);
    if (!fingerprints) {
      fingerprints = new Set();
      this.#approved.set(sessionId, fingerprints);
    }
    if (fingerprints.size >= MAX_APPROVED_FINGERPRINTS) {
      const oldestFingerprint = fingerprints.keys().next().value;
      if (oldestFingerprint !== undefined) fingerprints.delete(oldestFingerprint);
    }
    fingerprints.add(fingerprint);
  }

  clearForSession(sessionId: string): void {
    this.#approved.delete(sessionId);
    // 会话关闭时清理该会话在途请求的任务级授权（N4-P2-2）
    for (const [requestId, owner] of this.#requestSession) {
      if (owner === sessionId) {
        this.#requestApproved.delete(requestId);
        this.#requestSession.delete(requestId);
      }
    }
    for (const [requestId, entry] of this.#pending) {
      if (entry.request.sessionId === sessionId) {
        this.#pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.resolve({ approved: false, reason: 'session closed' });
      }
    }
  }
}
