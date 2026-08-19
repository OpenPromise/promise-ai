import WebSocket from 'ws';
import { createLocalTools } from './tools.js';

const wsUrl = process.env.AGENT_WS_URL ?? 'ws://127.0.0.1:3000/ws/desktop';
const localTools = createLocalTools();
const toolByName = new Map(localTools.map((tool) => [tool.declaration.name, tool]));

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
let shutdownRequested = false;

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
  ws = new WebSocket(wsUrl);

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

  if (message.type === 'tool.execute') {
    const name = message.name ?? '';
    const tool = toolByName.get(name);
    if (!tool) {
      send({
        type: 'tool.result',
        requestId: message.requestId,
        ok: false,
        error: `未知的本地工具：${name}`,
      });
      return;
    }
    try {
      const result = await tool.execute(message.arguments);
      send({ type: 'tool.result', requestId: message.requestId, ...result });
    } catch (error) {
      send({
        type: 'tool.result',
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
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
