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
}

export const DESKTOP_TOOL_TIMEOUT_MS = 60_000;

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
      if (this.#registry.has(declaration.name)) continue;
      const tool: Tool = {
        name: declaration.name,
        description: declaration.description,
        inputSchema: declaration.inputSchema,
        permissionLevel: declaration.permissionLevel,
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
      this.#registered.push(declaration.name);
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
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        resolve({ ok: false, error: `桌面工具 ${name} 执行超时（${timeoutMs}ms）` });
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(requestId, { resolve, timer });
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
    for (const name of this.#registered) {
      this.#registry.unregister(name);
    }
    this.#registered = [];
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: '桌面端已断开' });
    }
    this.#pending.clear();
  }
}
