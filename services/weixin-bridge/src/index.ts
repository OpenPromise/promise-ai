import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import QRCode from 'qrcode';
import type { AccountState } from './state.js';
import { StateStore } from './state.js';
import type { ILinkClientOptions } from './ilink.js';
import { ILinkClient } from './ilink.js';
import { LoginManager } from './login.js';
import { runWeixinRelay } from './relay.js';

try {
  const { config } = await import('dotenv');
  config();
} catch {
  // dotenv 缺失时使用环境变量/默认值
}

const port = Number(process.env.WEIXIN_PORT ?? 3100);
const agentUrl = process.env.AGENT_URL ?? 'http://127.0.0.1:3000';
const stateDir = process.env.WEIXIN_STATE_DIR ?? path.join(os.homedir(), '.weixin-bridge');
const channelVersion = process.env.WEIXIN_CHANNEL_VERSION ?? '0.1.0';
const botAgent = process.env.WEIXIN_BOT_AGENT ?? 'PromiseAi/0.1.0';
const baseUrl = process.env.WEIXIN_BASE_URL ?? undefined;

await mkdir(stateDir, { recursive: true });
const stateFile = path.join(stateDir, 'state.json');
const stateStore = await StateStore.open(stateFile);

let relayController: AbortController | null = null;
let relayRunning = false;
let relayStale = false;
let lastEventAt: number | undefined;

const log = (message: string): void => {
  console.log(`[weixin-bridge] ${message}`);
};

function makeClient(options: ILinkClientOptions = {}): ILinkClient {
  return new ILinkClient({
    baseUrl: baseUrl ?? options.baseUrl,
    token: options.token,
    channelVersion,
    botAgent,
  });
}

function authedClient(): ILinkClient | undefined {
  const account = stateStore.account;
  if (!account?.token) return undefined;
  return makeClient({ token: account.token, baseUrl: account.baseUrl });
}

/** 通过 sessionId 反查微信对端（state.peerSessions: peer -> sessionId）。 */
function resolvePeerBySession(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const account = stateStore.account;
  if (!account) return undefined;
  for (const [peer, sid] of Object.entries(account.peerSessions)) {
    if (sid === sessionId) return peer;
  }
  return undefined;
}

async function startRelay(): Promise<void> {
  const account = stateStore.account;
  if (!account?.token) return;
  relayController?.abort();
  relayController = new AbortController();
  const client = makeClient({ token: account.token, baseUrl: account.baseUrl });
  const signal = relayController.signal;
  relayRunning = true;
  relayStale = false;
  void runWeixinRelay(
    {
      agentUrl,
      client,
      state: account,
      persist: () => stateStore.save(),
      log: (message) => {
        log(message);
        lastEventAt = Date.now();
      },
    },
    signal,
  )
    .then((result) => {
      relayRunning = false;
      if (result.staleToken) {
        relayStale = true;
        log('登录态已失效，请重新扫码登录（POST /api/weixin/login）');
      }
    })
    .catch((error) => {
      relayRunning = false;
      log(`relay 异常退出：${error instanceof Error ? error.message : String(error)}`);
    });
}

async function stopRelay(): Promise<void> {
  relayController?.abort();
  relayController = null;
  relayRunning = false;
}

const loginManager = new LoginManager({
  client: makeClient(),
  localTokenList: () => (stateStore.account?.token ? [stateStore.account.token] : []),
});

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>微信 ClawBot 登录</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding-top: 40px; background: #f6f7f9; }
    .card { display: inline-block; background: #fff; border-radius: 16px; padding: 32px 40px; box-shadow: 0 8px 30px rgba(0,0,0,.08); }
    img { width: 260px; height: 260px; }
    #status { margin-top: 16px; color: #333; min-height: 24px; }
    button { margin-top: 12px; padding: 8px 20px; border: 0; border-radius: 8px; background: #07c160; color: #fff; font-size: 14px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h2>微信 ClawBot 扫码登录</h2>
    <div id="qr"><p style="color:#888">正在获取二维码…</p></div>
    <div id="status"></div>
    <button onclick="startLogin()" style="display:none" id="retry">重新生成二维码</button>
  </div>
  <script>
    let key = null;
    async function startLogin() {
      document.getElementById('qr').innerHTML = '<p style="color:#888">正在获取二维码…</p>';
      document.getElementById('status').textContent = '';
      const res = await fetch('/api/weixin/login', { method: 'POST' });
      const json = await res.json();
      if (!json.sessionKey) { document.getElementById('status').textContent = '获取二维码失败：' + (json.error || ''); return; }
      key = json.sessionKey;
      document.getElementById('qr').innerHTML = json.qrcodeDataUrl
        ? '<img src="' + json.qrcodeDataUrl + '" alt="登录二维码"/>'
        : '<p>' + json.qrcodeUrl + '</p>';
      document.getElementById('retry').style.display = 'none';
      poll();
    }
    async function poll() {
      if (!key) return;
      try {
        const res = await fetch('/api/weixin/login/' + encodeURIComponent(key));
        const json = await res.json();
        const statusEl = document.getElementById('status');
        if (json.status === 'confirmed') {
          statusEl.textContent = '✅ 登录成功，机器人已上线！';
          document.getElementById('qr').innerHTML = '<p style="font-size:48px">🎉</p>';
          return;
        }
        if (json.status === 'need_verifycode') {
          const code = prompt('请在手机微信上确认后，输入显示的数字：');
          if (code) {
            await fetch('/api/weixin/login/' + encodeURIComponent(key) + '/verify', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ code: code.trim() })
            });
          }
          poll();
          return;
        }
        statusEl.textContent = {
          wait: '⏳ 请用手机微信扫描二维码',
          scaned: '👀 已扫码，请在手机上确认',
          expired: '❌ 二维码已过期',
          verify_code_blocked: '⛔ 验证码错误过多，请重新生成',
          scaned_but_redirect: '🔄 正在连接…',
          binded_redirect: '✅ 该微信号已连接过，直接使用现有登录态'
        }[json.status] || json.status;
        if (json.status === 'expired' || json.status === 'verify_code_blocked') {
          document.getElementById('retry').style.display = '';
          return;
        }
        poll();
      } catch (e) {
        setTimeout(poll, 3000);
      }
    }
    startLogin();
  </script>
</body>
</html>`;

app.get('/health', async () => ({
  status: 'ok',
  loggedIn: Boolean(stateStore.account?.token),
  accountId: stateStore.account?.accountId,
  relayRunning,
  stale: relayStale,
}));

app.get('/api/weixin/status', async () => ({
  loggedIn: Boolean(stateStore.account?.token),
  accountId: stateStore.account?.accountId,
  userId: stateStore.account?.userId,
  peers: Object.keys(stateStore.account?.peerSessions ?? {}).length,
  relayRunning,
  stale: relayStale,
  lastEventAt,
}));

app.post('/api/weixin/login', async () => {
  try {
    const login = await loginManager.start();
    const qrcodeDataUrl = await QRCode.toDataURL(login.qrcodeUrl, { width: 260, margin: 1 });
    return { sessionKey: login.sessionKey, qrcodeUrl: login.qrcodeUrl, qrcodeDataUrl };
  } catch (error) {
    app.log.error({ err: error }, 'start weixin login failed');
    return { error: error instanceof Error ? error.message : String(error) };
  }
});

app.post('/api/weixin/login/:key/verify', async (request) => {
  const params = request.params as { key: string };
  const body = (request.body ?? {}) as { code?: string };
  await loginManager.setVerifyCode(params.key, body.code ?? '');
  return { ok: true };
});

app.get('/api/weixin/login/:key', async (request) => {
  const params = request.params as { key: string };
  const result = await loginManager.poll(params.key);
  if (result.status === 'confirmed' && result.botToken && result.accountId) {
    const account: AccountState = {
      token: result.botToken,
      baseUrl: result.baseUrl ?? baseUrl ?? 'https://ilinkai.weixin.qq.com',
      accountId: result.accountId,
      userId: result.userId,
      peerSessions: stateStore.account?.peerSessions ?? {},
      savedAt: new Date().toISOString(),
    };
    await stateStore.setAccount(account);
    await startRelay();
  }
  return result;
});

app.post('/api/weixin/logout', async () => {
  await stopRelay();
  await stateStore.clearAccount();
  return { ok: true };
});

app.post('/api/weixin/send-image', async (request, reply) => {
  const body = (request.body ?? {}) as {
    sessionId?: string;
    imageBase64?: string;
    contextToken?: string;
    runId?: string;
  };
  const client = authedClient();
  if (!client) return reply.code(401).send({ error: '微信未登录' });
  const peer = resolvePeerBySession(body.sessionId);
  if (!peer) return reply.code(404).send({ error: '找不到该会话对应的微信对端' });
  const image = Buffer.from(body.imageBase64 ?? '', 'base64');
  if (image.length === 0) return reply.code(400).send({ error: '缺少 imageBase64' });
  try {
    await client.sendImageToUser({
      to: peer,
      image,
      contextToken: body.contextToken,
      runId: body.runId,
    });
    return { ok: true };
  } catch (error) {
    app.log.error({ err: error }, 'send weixin image failed');
    return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/weixin/send-voice', async (request, reply) => {
  const body = (request.body ?? {}) as {
    sessionId?: string;
    audioBase64?: string;
    encodeType?: number;
    sampleRate?: number;
    playtimeMs?: number;
    contextToken?: string;
    runId?: string;
  };
  const client = authedClient();
  if (!client) return reply.code(401).send({ error: '微信未登录' });
  const peer = resolvePeerBySession(body.sessionId);
  if (!peer) return reply.code(404).send({ error: '找不到该会话对应的微信对端' });
  const audio = Buffer.from(body.audioBase64 ?? '', 'base64');
  if (audio.length === 0) return reply.code(400).send({ error: '缺少 audioBase64' });
  try {
    await client.sendVoiceToUser({
      to: peer,
      audio,
      encodeType: body.encodeType ?? 7,
      sampleRate: body.sampleRate,
      playtimeMs: body.playtimeMs,
      contextToken: body.contextToken,
      runId: body.runId,
    });
    return { ok: true };
  } catch (error) {
    app.log.error({ err: error }, 'send weixin voice failed');
    return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/weixin/login', async (_request, reply) => {
  return reply.type('text/html; charset=utf-8').send(LOGIN_PAGE);
});

// 已登录过则直接启动中继
if (stateStore.account?.token) {
  await startRelay();
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'stopping weixin-bridge');
  await stopRelay();
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(
    {
      port,
      agentUrl,
      loggedIn: Boolean(stateStore.account?.token),
      stateFile,
    },
    'weixin-bridge started',
  );
} catch (error) {
  app.log.error({ err: error }, 'failed to start weixin-bridge');
  process.exit(1);
}
