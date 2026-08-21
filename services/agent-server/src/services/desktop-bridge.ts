import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type {
  DesktopToolDeclaration,
  Tool,
  ToolContext,
  ToolRegistry,
  ToolResult,
} from '@personal-ai/tools';

interface PendingRequest {
  resolve: (result: ToolResult) => void;
  timer: NodeJS.Timeout;
  /** signal 上的 abort 监听器，请求结束时移除，避免长会话 signal 堆积监听。 */
  detach?: () => void;
}

export const DESKTOP_TOOL_TIMEOUT_MS = 60_000;

/** 注入工具的命名空间前缀：桌面端工具名不得与内置工具冲突/顶替。 */
export const DESKTOP_TOOL_PREFIX = 'desktop.';

/**
 * 服务端强制的桌面工具权限级别。桌面端自报的 permissionLevel 属于
 * 不可信输入——任何连上来的客户端都能把 terminal.run 声明成 L0 从而
 * 绕过审批。桌面工具在主人机器上执行任意本机操作，统一按 L2（敏感，
 * 需确认 + 指纹记忆）处理；这也顺带让它们在微信渠道被自动拒绝。
 */
export const DESKTOP_FORCED_PERMISSION_LEVEL = 2 as const;

/**
 * Bridges remote desktop tools into the shared ToolRegistry. A desktop agent
 * connects via /ws/desktop, declares its local capabilities, and executes
 * tool calls locally; results are sent back over the same WebSocket.
 */
export class DesktopToolBridge {
  readonly #registry: ToolRegistry;
  readonly #ws: WebSocket;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #timeoutMs: number;
  /** 本连接注册的工具名（含 desktop. 前缀）→ 注册时放入的 Tool 实例（归属凭证）。 */
  readonly #owned = new Map<string, Tool>();
  #registered: string[] = [];

  constructor(registry: ToolRegistry, ws: WebSocket, options: { timeoutMs?: number } = {}) {
    this.#registry = registry;
    this.#ws = ws;
    this.#timeoutMs = options.timeoutMs ?? DESKTOP_TOOL_TIMEOUT_MS;
    ws.on('message', (data) => this.#handleMessage(data));
    ws.on('close', () => this.#cleanup());
    ws.on('error', () => this.#cleanup());
  }

  /** Registers the desktop's declared tools. Returns the names actually registered. */
  registerTools(tools: DesktopToolDeclaration[]): string[] {
    for (const declaration of tools) {
      // 命名空间隔离：注册名加 desktop. 前缀，远端执行仍用桌面端原始名
      // （协议不变），这样桌面端无法用同名工具顶替/伪装内置工具。
      const localName = `${DESKTOP_TOOL_PREFIX}${declaration.name}`;
      if (this.#registry.has(localName)) continue;
      const tool: Tool = {
        name: localName,
        description: declaration.description,
        inputSchema: declaration.inputSchema,
        // 服务端强制级别：忽略客户端自报的 declaration.permissionLevel。
        permissionLevel: DESKTOP_FORCED_PERMISSION_LEVEL,
        ...(declaration.timeoutMs ? { timeoutMs: declaration.timeoutMs } : {}),
        execute: (input, context) =>
          this.#executeRemote(
            declaration.name,
            input,
            context,
            declaration.timeoutMs ?? this.#timeoutMs,
          ),
      };
      this.#registry.register(tool);
      this.#owned.set(localName, tool);
      this.#registered.push(localName);
    }
    return this.#registered;
  }

  #executeRemote(
    name: string,
    input: unknown,
    context: ToolContext,
    timeoutMs = this.#timeoutMs,
  ): Promise<ToolResult> {
    const requestId = randomUUID();
    return new Promise<ToolResult>((resolve) => {
      const settle = (result: ToolResult): void => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.detach?.();
        resolve(result);
      };
      const timer = setTimeout(() => {
        settle({ ok: false, error: `桌面工具 ${name} 执行超时（${timeoutMs}ms）` });
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(requestId, { resolve, timer });

      // 取消传播：会话被中断（用户取消/连接断开）时立即结束等待，
      // 并通知桌面端放弃这次执行，避免本机继续跑一个没人要的操作。
      const signal = context.signal;
      if (signal) {
        const onAbort = (): void => {
          this.#send({ type: 'tool.cancel', requestId, name });
          settle({ ok: false, error: `桌面工具 ${name} 已取消` });
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        const pending = this.#pending.get(requestId);
        if (pending) pending.detach = () => signal.removeEventListener('abort', onAbort);
      }

      this.#send({
        type: 'tool.execute',
        requestId,
        name,
        arguments: input,
        sessionId: context.sessionId,
      });
    });
  }

  #handleMessage(raw: WebSocket.RawData): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof message.type === 'string' ? message.type : '';
    if (type === 'hello') {
      const tools = Array.isArray(message.tools) ? (message.tools as DesktopToolDeclaration[]) : [];
      const registered = this.registerTools(tools);
      this.#send({ type: 'tools.registered', tools: registered });
      return;
    }

    if (type === 'tool.result') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const pending = this.#pending.get(requestId);
      if (!pending) return;
      this.#pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.detach?.();
      pending.resolve({
        ok: message.ok === true,
        ...(message.data !== undefined ? { data: message.data } : {}),
        ...(typeof message.error === 'string' ? { error: message.error } : {}),
      });
    }
  }

  #send(payload: unknown): void {
    if (this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(payload));
    }
  }

  #cleanup(): void {
    for (const [name, tool] of this.#owned) {
      // 只注销仍归属自己的注册：若名字已被后来的连接重新注册（注册表里
      // 的实例不是我们放进去的那个），断开时不能把别人的工具删掉。
      if (this.#registry.get(name) === tool) {
        this.#registry.unregister(name);
      }
    }
    this.#owned.clear();
    this.#registered = [];
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.detach?.();
      pending.resolve({ ok: false, error: '桌面端已断开' });
    }
    this.#pending.clear();
  }
}
