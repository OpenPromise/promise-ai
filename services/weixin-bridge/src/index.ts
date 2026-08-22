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
import { runEventPusher } from './event-pusher.js';
import {
  deleteLibraryFile,
  listLibraryFiles,
  readLibraryFile,
  resolveFileByName,
} from './files.js';
import { FileJobManager } from './jobs.js';
import { checkBridgeAuth } from './auth.js';
import { DEFAULT_VISION_ENDPOINT, DEFAULT_VISION_MODEL } from './vision.js';

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
const visionModel = process.env.WEIXIN_VISION_MODEL ?? DEFAULT_VISION_MODEL;
const visionEndpoint = process.env.WEIXIN_VISION_ENDPOINT ?? DEFAULT_VISION_ENDPOINT;
const filesDir = process.env.WEIXIN_FILES_DIR ?? path.join(stateDir, 'files');
/** 桥自身端点的共享 token（未配置时受保护端点全拒）。 */
const bridgeToken = process.env.BRIDGE_TOKEN?.trim() || undefined;
/** 调 agent-server API 用的共享 token（两个容器配同一个 AGENT_API_TOKEN）。 */
const agentApiToken = process.env.AGENT_API_TOKEN?.trim() || undefined;

await mkdir(stateDir, { recursive: true });
const stateFile = path.join(stateDir, 'state.json');
const stateStore = await StateStore.open(stateFile);

let relayController: AbortController | null = null;
let eventController: AbortController | null = null;
let relayRunning = false;
let relayStale = false;
let lastEventAt: number | undefined;

const log = (message: string): void => {
  console.log(`[weixin-bridge] ${message}`);
};

const jobManager = new FileJobManager({
  filesDir,
  clientFactory: () => {
    const client = authedClient();
    if (!client) throw new Error('微信未登录');
    return client;
  },
  log,
});

function makeClient(options: ILinkClientOptions = {}): ILinkClient {
  return new ILinkClient({
    baseUrl: baseUrl ?? options.baseUrl,
    token: options.token,
    channelVersion,
    botAgent,
    log,
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
      vision: {
        apiKey: process.env.DEEPSEEK_API_KEY,
        model: visionModel,
        endpoint: visionEndpoint,
      },
      filesDir,
      apiToken: agentApiToken,
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
  startEventPusher();
}

async function stopRelay(): Promise<void> {
  relayController?.abort();
  relayController = null;
  eventController?.abort();
  eventController = null;
  relayRunning = false;
}

function startEventPusher(): void {
  const account = stateStore.account;
  if (!account?.token) return;
  eventController?.abort();
  eventController = new AbortController();
  const client = makeClient({ token: account.token, baseUrl: account.baseUrl });
  void runEventPusher(
    {
      agentUrl,
      client,
      peers: () => Object.keys(stateStore.account?.peerSessions ?? {}),
      log,
      apiToken: agentApiToken,
    },
    eventController.signal,
  ).catch((error) => {
    log(`事件推送退出：${error instanceof Error ? error.message : String(error)}`);
  });
}

const loginManager = new LoginManager({
  client: makeClient(),
  localTokenList: () => (stateStore.account?.token ? [stateStore.account.token] : []),
});

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

// 桥端点鉴权（N-P1-9）：除探活与扫码登录链路外都要 x-bridge-token。
// 未配置 BRIDGE_TOKEN 时受保护端点一律 401——发消息/删文件这类能力不能裸奔。
app.addHook('onRequest', async (request, reply) => {
  const result = checkBridgeAuth({
    url: request.url,
    headers: request.headers,
    token: bridgeToken,
  });
  if (!result.ok) {
    return reply.code(result.status).send({ error: result.error });
  }
});
if (!bridgeToken) {
  log('⚠️ 未配置 BRIDGE_TOKEN：除 /health 与扫码登录页外，桥端点全部拒绝访问');
}

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
        if (json.status === 'error') {
          statusEl.textContent = '❌ 登录状态查询失败：' + (json.error || '请检查网络后重试');
          document.getElementById('retry').style.display = '';
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
  // 优先当前微信会话对端；非微信会话（桌面/网页等）回退到已绑定的微信账号。
  const peer =
    resolvePeerBySession(body.sessionId) ?? Object.keys(stateStore.account?.peerSessions ?? {})[0];
  if (!peer) return reply.code(404).send({ error: '没有已绑定的微信账号' });
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

app.get('/api/weixin/files', async () => {
  const files = await listLibraryFiles(filesDir);
  return { count: files.length, files };
});

app.post('/api/weixin/send-file', async (request, reply) => {
  const body = (request.body ?? {}) as {
    sessionId?: string;
    fileName?: string;
    contextToken?: string;
    runId?: string;
  };
  const client = authedClient();
  if (!client) return reply.code(401).send({ error: '微信未登录' });
  // 优先当前微信会话对端；非微信会话（桌面/网页等）回退到已绑定的微信账号。
  const peer =
    resolvePeerBySession(body.sessionId) ?? Object.keys(stateStore.account?.peerSessions ?? {})[0];
  if (!peer) return reply.code(404).send({ error: '没有已绑定的微信账号' });
  const query = body.fileName?.trim();
  if (!query) return reply.code(400).send({ error: '缺少 fileName' });

  const files = await listLibraryFiles(filesDir);
  const matched = resolveFileByName(files, query);
  if (!matched) {
    return reply.code(404).send({ error: `文件库中找不到「${query}」` });
  }
  const loaded = await readLibraryFile(filesDir, matched.name);
  if (!loaded) return reply.code(404).send({ error: `无法读取文件「${matched.name}」` });
  if (loaded.bytes.length > 100 * 1024 * 1024) {
    return reply.code(413).send({ error: `文件超过 100MB 上限：${matched.name}` });
  }
  try {
    await client.sendFileToUser({
      to: peer,
      file: loaded.bytes,
      fileName: loaded.name,
      contextToken: body.contextToken,
      runId: body.runId,
    });
    return { ok: true, sent: loaded.name, size: loaded.bytes.length };
  } catch (error) {
    app.log.error({ err: error }, 'send weixin file failed');
    return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/weixin/send-file-async', async (request, reply) => {
  const body = (request.body ?? {}) as {
    sessionId?: string;
    fileName?: string;
  };
  if (!authedClient()) return reply.code(401).send({ error: '微信未登录' });
  const peer =
    resolvePeerBySession(body.sessionId) ?? Object.keys(stateStore.account?.peerSessions ?? {})[0];
  if (!peer) return reply.code(404).send({ error: '没有已绑定的微信账号' });
  const query = body.fileName?.trim();
  if (!query) return reply.code(400).send({ error: '缺少 fileName' });
  try {
    const { job, deduped } = await jobManager.start(peer, query);
    return {
      ok: true,
      jobId: job.id,
      status: job.status,
      fileName: job.fileName,
      size: job.size,
      deduped,
    };
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/weixin/delete-file', async (request, reply) => {
  const body = (request.body ?? {}) as { fileName?: string };
  const query = body.fileName?.trim();
  if (!query) return reply.code(400).send({ error: '缺少 fileName' });
  try {
    const deleted = await deleteLibraryFile(filesDir, query);
    return { ok: true, fileName: deleted };
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/weixin/jobs', async () => {
  const jobs = jobManager.list();
  return { count: jobs.length, jobs };
});

app.get('/api/weixin/jobs/:id', async (request, reply) => {
  const params = request.params as { id: string };
  const job = jobManager.get(params.id);
  if (!job) return reply.code(404).send({ error: '任务不存在' });
  return job;
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
