import WebSocket from 'ws';
import { createLocalTools } from './tools.js';

const wsUrl = process.env.AGENT_WS_URL ?? 'ws://127.0.0.1:3000/ws/desktop';
const desktopToken = process.env.DESKTOP_TOKEN ?? '';
const localTools = createLocalTools();
const toolByName = new Map(localTools.map((tool) => [tool.declaration.name, tool]));

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
let shutdownRequested = false;
/** 服务端已取消的请求：结果回来时直接丢弃，不再往回发。 */
const cancelledRequests = new Set<string>();

function send(message: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/** 指数退避重连：1s → 2s → 4s … 封顶 30s；连接成功即复位。 */
function scheduleReconnect(): void {
  if (shutdownRequested) return;
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt, RECONNECT_MAX_DELAY_MS);
  reconnectAttempt += 1;
  console.log(
    `[desktop] will reconnect in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt})`,
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  if (shutdownRequested) return;
  if (!desktopToken) {
    console.error('[desktop] DESKTOP_TOKEN 未配置，agent-server 会拒绝握手；请先配置后重启');
  }
  // /ws/desktop 需要 token：ws 客户端支持自定义头，服务端也接受 ?token=。
  ws = new WebSocket(wsUrl, {
    headers: desktopToken ? { 'x-desktop-token': desktopToken } : {},
  });

  ws.on('open', () => {
    reconnectAttempt = 0;
    console.log(`[desktop] connected to ${wsUrl}`);
    send({
      type: 'hello',
      tools: localTools.map((tool) => tool.declaration),
    });
  });

  ws.on('message', (data) => {
    void handleMessage(data.toString());
  });

  ws.on('error', (error) => {
    console.error(`[desktop] websocket error: ${error.message}`);
  });

  ws.on('close', (code, reason) => {
    console.log(`[desktop] disconnected (${code} ${reason.toString()})`);
    ws = null;
    scheduleReconnect();
  });
}

connect();

async function handleMessage(raw: string): Promise<void> {
  let message: {
    type?: string;
    requestId?: string;
    name?: string;
    arguments?: unknown;
    tools?: string[];
  };
  try {
    message = JSON.parse(raw) as typeof message;
  } catch {
    return;
  }

  if (message.type === 'tools.registered') {
    console.log(`[desktop] tools registered: ${(message.tools ?? []).join(', ')}`);
    return;
  }

  // 服务端取消（会话中断/超时）：本地无法中止已启动的操作，但结果不再回传，
  // 避免服务端把过期结果当成当前请求的答案。
  if (message.type === 'tool.cancel') {
    if (message.requestId) cancelledRequests.add(message.requestId);
    console.log(`[desktop] cancelled ${message.name ?? ''} (${message.requestId ?? ''})`);
    return;
  }

  if (message.type === 'tool.execute') {
    const requestId = message.requestId;
    const reply = (payload: Record<string, unknown>): void => {
      if (requestId && cancelledRequests.delete(requestId)) return;
      send({ type: 'tool.result', requestId, ...payload });
    };
    const name = message.name ?? '';
    const tool = toolByName.get(name);
    if (!tool) {
      reply({ ok: false, error: `未知的本地工具：${name}` });
      return;
    }
    try {
      const result = await tool.execute(message.arguments);
      reply({ ...result });
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

const shutdown = (signal: string): void => {
  console.log(`[desktop] ${signal}, closing`);
  shutdownRequested = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  ws?.close();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
