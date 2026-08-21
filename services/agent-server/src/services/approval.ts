import { randomUUID } from 'node:crypto';

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
 * Tracks in-flight permission requests for L2/L3 tool calls. The agent loop
 * awaits the promise; the transport layer (SSE endpoint or voice WebSocket)
 * resolves it via {@link respond}. Requests auto-deny on timeout.
 */
export class ApprovalRegistry {
  readonly #pending = new Map<string, PendingApproval>();
  readonly #approved = new Map<string, Set<string>>();
  /** 任务级（单次请求）授权：requestId -> 已放行的工具名集合。 */
  readonly #requestApproved = new Map<string, Set<string>>();
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

  /** Resolves a pending request. Returns false when the request is unknown/expired. */
  respond(requestId: string, decision: ApprovalDecision): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    return true;
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

  /** 该请求（一次用户指令的多步工具循环）内该工具是否已放行。 */
  isRequestApproved(requestId: string | undefined, toolName: string): boolean {
    if (!requestId) return false;
    return this.#requestApproved.get(requestId)?.has(toolName) ?? false;
  }

  /** 记住"Allow once"：本次请求后续对该工具的调用自动放行（OpenDex 任务级授权）。 */
  rememberRequestApproval(requestId: string | undefined, toolName: string): void {
    if (!requestId) return;
    let names = this.#requestApproved.get(requestId);
    if (!names) {
      names = new Set();
      this.#requestApproved.set(requestId, names);
    }
    names.add(toolName);
  }

  /** 请求结束（成功/失败/超轮数）后清理任务级授权，避免跨请求泄漏。 */
  clearForRequest(requestId: string | undefined): void {
    if (!requestId) return;
    this.#requestApproved.delete(requestId);
  }

  /** Remembers an approved call so an identical one can auto-run. */
  rememberApproval(sessionId: string, fingerprint: string): void {
    if (!this.#rememberApprovals) return;
    let fingerprints = this.#approved.get(sessionId);
    if (!fingerprints) {
      fingerprints = new Set();
      this.#approved.set(sessionId, fingerprints);
    }
    fingerprints.add(fingerprint);
  }

  clearForSession(sessionId: string): void {
    this.#approved.delete(sessionId);
    for (const [requestId, entry] of this.#pending) {
      if (entry.request.sessionId === sessionId) {
        this.#pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.resolve({ approved: false, reason: 'session closed' });
      }
    }
  }
}
