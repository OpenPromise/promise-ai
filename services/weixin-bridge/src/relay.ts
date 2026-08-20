import { randomUUID } from 'node:crypto';
import type { ILinkClient, WeixinMessage } from './ilink.js';
import { buildReplyMessage, extractInboundText, STALE_TOKEN_ERRCODE } from './ilink.js';
import { markdownToPlain, splitLongText } from './markdown.js';
import { describeImageWithDashScope } from './vision.js';
import { saveLibraryFile } from './files.js';
import type { AccountState } from './state.js';

export interface RelayOptions {
  agentUrl: string;
  client: ILinkClient;
  state: AccountState;
  /** 持久化 state（syncBuf / peerSessions 变化后调用）。 */
  persist: () => Promise<void>;
  /** 收图理解：DashScope 视觉模型配置（apiKey / model）。 */
  vision?: { apiKey?: string; model?: string; fetchImpl?: typeof fetch };
  /** 文件库目录：微信发来的文件自动保存到这里，供按名发送。 */
  filesDir?: string;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

const LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;

export interface ChatReply {
  text: string;
  error?: string;
}

interface PendingApproval {
  sessionId: string;
  requestId: string;
  toolName: string;
  resolve: () => void;
  timer: NodeJS.Timeout;
}

/** 待授权请求（sessionId -> pending）；由用户下一条微信文字答复。 */
const pendingApprovals = new Map<string, PendingApproval>();
/** 正在处理中的会话（防止并发开多个聊天）。 */
const inflightSessions = new Set<string>();

/** 解析微信文字授权答复：允许 / 拒绝 / 未识别。 */
export function parseApprovalText(text: string): 'allow' | 'deny' | undefined {
  const t = text.trim().replace(/[。！!？?，,、\s]+$/g, '').toLowerCase();
  if (/^(允许|同意|可以|好|行|是|继续|执行|确认|yes|ok|approve|allow)$/.test(t)) {
    return 'allow';
  }
  if (/^(拒绝|不要|不行|不可以|取消|否|算了|no|deny|cancel|reject)$/.test(t)) {
    return 'deny';
  }
  return undefined;
}

/** 与 agent-server 完成一轮对话：POST /chat 消费 SSE；权限请求改为微信文字审批。 */
export async function chatOnce(
  agentUrl: string,
  sessionId: string,
  userMessage: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    log?: (message: string) => void;
    /** 权限请求到达时回调（发送微信授权提示）。 */
    onPermissionRequest?: (info: { requestId: string; toolName: string }) => void;
  } = {},
): Promise<ChatReply> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${agentUrl.replace(/\/+$/, '')}/api/sessions/${sessionId}/chat`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: userMessage, requestId: randomUUID() }),
      signal: options.signal,
    },
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    return { text: '', error: `Agent 服务返回 ${response.status}：${detail}` };
  }

  let text = '';
  let error: string | undefined;
  let lastRequestId: string | undefined;
  try {
    await consumeSse(response, (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) return;
      let envelope: {
        type?: string;
        payload?: {
          delta?: string;
          error?: string;
          request?: { requestId?: string; toolName?: string };
        };
      };
      try {
        envelope = JSON.parse(trimmed.slice(6)) as typeof envelope;
      } catch {
        return;
      }
      switch (envelope.type) {
        case 'chat.token':
          text += envelope.payload?.delta ?? '';
          break;
        case 'permission.request': {
          const requestId = envelope.payload?.request?.requestId ?? '';
          const toolName = envelope.payload?.request?.toolName ?? '';
          if (!requestId) break;
          lastRequestId = requestId;
          // 登记待授权：用户下一条微信文字答复后由 handleInboundMessage 触发。
          const timer = setTimeout(() => {
            if (pendingApprovals.get(sessionId)?.requestId === requestId) {
              pendingApprovals.delete(sessionId);
            }
          }, 70_000);
          timer.unref?.();
          pendingApprovals.set(sessionId, {
            sessionId,
            requestId,
            toolName: toolName || '未知操作',
            resolve: () => {
              if (pendingApprovals.get(sessionId)?.requestId === requestId) {
                pendingApprovals.delete(sessionId);
              }
              clearTimeout(timer);
            },
            timer,
          });
          options.onPermissionRequest?.({ requestId, toolName: toolName || '未知操作' });
          break;
        }
        case 'chat.error':
          error = envelope.payload?.error ?? '未知错误';
          break;
      }
    });
  } finally {
    if (lastRequestId) {
      const pending = pendingApprovals.get(sessionId);
      if (pending?.requestId === lastRequestId) {
        clearTimeout(pending.timer);
        pendingApprovals.delete(sessionId);
      }
    }
  }

  return { text, error };
}

/** 逐行消费 SSE 响应（跨 chunk 处理半行）。 */
export async function consumeSse(
  response: Response,
  onLine: (line: string) => void,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    }
  } finally {
    reader.releaseLock();
  }
}

async function ensureSession(
  agentUrl: string,
  peer: string,
  state: AccountState,
  persist: () => Promise<void>,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  const existing = state.peerSessions[peer];
  if (existing) return existing;
  try {
    const response = await fetchImpl(`${agentUrl.replace(/\/+$/, '')}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { weixinPeer: peer } }),
    });
    if (!response.ok) return undefined;
    const session = (await response.json()) as { id?: string };
    if (!session.id) return undefined;
    state.peerSessions[peer] = session.id;
    await persist();
    return session.id;
  } catch {
    return undefined;
  }
}

async function handleInboundMessage(msg: WeixinMessage, options: RelayOptions): Promise<void> {
  const { agentUrl, client, state, persist, log } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (msg.message_type === 2) return; // 机器人自己的消息
  if (msg.group_id) {
    log?.(`[weixin] 群聊消息暂不支持，跳过 group=${msg.group_id}`);
    return;
  }
  const peer = msg.from_user_id ?? '';
  const text = extractInboundText(msg);
  if (!peer) return;

  const parts: string[] = [];
  if (text.trim()) parts.push(text.trim());

  // 图片理解：有 image_item 时下载解密并调用视觉模型描述。
  const imageItem = msg.item_list?.find((item) => item.type === 2);
  if (imageItem?.image_item) {
    let description = '';
    try {
      const { media, aeskey } = imageItem.image_item;
      const aesKeyBase64 = aeskey ? Buffer.from(aeskey, 'hex').toString('base64') : media?.aes_key;
      const bytes = await client.downloadMedia({
        encryptQueryParam: media?.encrypt_query_param,
        fullUrl: media?.full_url,
        aesKeyBase64,
      });
      description = await describeImageWithDashScope({
        apiKey: options.vision?.apiKey,
        model: options.vision?.model,
        imageBytes: bytes,
        fetchImpl: options.vision?.fetchImpl ?? fetchImpl,
      });
    } catch (error) {
      log?.(`[weixin] 图片识别失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const imagePart = description
      ? `[用户发来一张图片]\n图片内容：${description}`
      : '[用户发来一张图片（内容识别失败，如需可向用户询问）]';
    parts.push(imagePart);
  }

  // 文件入库：有 file_item 时下载解密并保存到文件库。
  const fileItem = msg.item_list?.find((item) => item.type === 4);
  if (fileItem?.file_item && options.filesDir) {
    try {
      const { media } = fileItem.file_item;
      const bytes = await client.downloadMedia({
        encryptQueryParam: media?.encrypt_query_param,
        fullUrl: media?.full_url,
        aesKeyBase64: media?.aes_key,
      });
      const saved = await saveLibraryFile(
        options.filesDir,
        fileItem.file_item.file_name ?? 'file.bin',
        bytes,
      );
      parts.push(`[用户发来文件：${saved}，已保存到文件库，之后可用文件名要求发送]`);
    } catch (error) {
      log?.(`[weixin] 文件保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (parts.length === 0) return;
  const userMessage = parts.join('\n');

  const sessionId = await ensureSession(agentUrl, peer, state, persist, fetchImpl);
  if (!sessionId) {
    log?.(`[weixin] 无法为 ${peer} 创建会话，跳过`);
    return;
  }

  // 权限审批：存在待授权请求时，本条文字视为允许/拒绝答复。
  const pending = pendingApprovals.get(sessionId);
  if (pending) {
    const decision = parseApprovalText(text);
    if (decision === undefined) {
      await fetchImpl(`${agentUrl.replace(/\/+$/, '')}/api/sessions/${sessionId}/permission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: pending.requestId,
          approved: false,
          reason: '未识别为允许，已按拒绝处理',
        }),
      }).catch(() => {});
      pending.resolve();
      await client.sendMessage(
        buildReplyMessage({
          to: peer,
          text: '没有识别到「允许」或「拒绝」，该操作已取消；需要的话重新发起即可。',
          contextToken: msg.context_token,
          runId: msg.run_id,
        }),
      );
      return;
    }
    const approved = decision === 'allow';
    await fetchImpl(`${agentUrl.replace(/\/+$/, '')}/api/sessions/${sessionId}/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: pending.requestId,
        approved,
        reason: approved ? '用户微信文字允许' : '用户微信文字拒绝',
      }),
    }).catch(() => {});
    pending.resolve();
    if (!approved) {
      await client.sendMessage(
        buildReplyMessage({
          to: peer,
          text: '已拒绝该操作。',
          contextToken: msg.context_token,
          runId: msg.run_id,
        }),
      );
    }
    return;
  }

  // 同一会话上一轮还没结束（含正在等授权），避免并发开聊天。
  if (inflightSessions.has(sessionId)) {
    await client.sendMessage(
      buildReplyMessage({
        to: peer,
        text: '⏳ 上一条还在处理中，请稍候再发。',
        contextToken: msg.context_token,
        runId: msg.run_id,
      }),
    );
    return;
  }

  // 输入中提示（尽力而为）
  try {
    const cfg = await client.getConfig(peer, msg.context_token);
    await client.sendTyping(peer, cfg.typing_ticket, 1);
  } catch {
    // typing 失败不影响主流程
  }

  // 后台消费聊天流：权限请求到达时发授权提示，等待用户下一条微信文字；
  // 不阻塞长轮询循环（否则用户回复无法被收到）。
  inflightSessions.add(sessionId);
  void (async () => {
    try {
      const reply = await chatOnce(agentUrl, sessionId, userMessage, {
        fetchImpl,
        log,
        onPermissionRequest: (info) => {
          void client
            .sendMessage(
              buildReplyMessage({
                to: peer,
                text: `⚠️ 需要你的授权：${info.toolName}\n回复「允许」继续，或「拒绝」取消。`,
                contextToken: msg.context_token,
                runId: msg.run_id,
              }),
            )
            .catch(() => {});
        },
      });
      const replyParts: string[] = [];
      if (reply.text) replyParts.push(markdownToPlain(reply.text));
      if (reply.error) replyParts.push(`❌ ${reply.error}`);
      if (replyParts.length === 0) return;
      for (const chunk of splitLongText(replyParts.join('\n\n'))) {
        await client.sendMessage(
          buildReplyMessage({
            to: peer,
            text: chunk,
            contextToken: msg.context_token,
            runId: msg.run_id,
          }),
        );
      }
    } catch (error) {
      log?.(`[weixin] 对话失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inflightSessions.delete(sessionId);
    }
  })();
}

/**
 * getUpdates 长轮询主循环：拉消息 -> 转发 agent-server -> 回微信。
 * errcode -14 表示 token 失效，需要重新扫码登录。
 */
export async function runWeixinRelay(
  options: RelayOptions,
  signal: AbortSignal,
): Promise<{ stopped: boolean; staleToken: boolean }> {
  const { client, state, persist, log } = options;
  log?.(`[weixin] relay started (baseUrl=${client.baseUrl}, account=${state.accountId})`);
  try {
    await client.notifyStart();
  } catch (error) {
    log?.(`[weixin] notifyStart 失败：${error instanceof Error ? error.message : String(error)}`);
  }

  let syncBuf = state.syncBuf ?? '';
  let nextTimeoutMs = LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;
  let totalPolls = 0;
  let lastHeartbeatAt = Date.now();

  while (!signal.aborted) {
    try {
      const resp = await client.getUpdates(syncBuf, {
        timeoutMs: nextTimeoutMs,
        signal,
      });
      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }
      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);
      if (isApiError) {
        consecutiveFailures += 1;
        if (resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE) {
          log?.(`[weixin] token 已失效（-14），需要重新扫码登录`);
          await client.notifyStop().catch(() => {});
          return { stopped: true, staleToken: true };
        }
        log?.(
          `[weixin] getUpdates 失败 ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''}（${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}）`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, signal);
        } else {
          await sleep(RETRY_DELAY_MS, signal);
        }
        continue;
      }
      consecutiveFailures = 0;
      totalPolls += 1;
      const now = Date.now();
      if (now - lastHeartbeatAt >= 60_000) {
        lastHeartbeatAt = now;
        log?.(`[weixin] relay 轮询正常（第 ${totalPolls} 次）`);
      }

      if (resp.get_updates_buf !== undefined && resp.get_updates_buf !== '') {
        syncBuf = resp.get_updates_buf;
        state.syncBuf = syncBuf;
        await persist().catch(() => {});
      }
      for (const msg of resp.msgs ?? []) {
        try {
          // 单条消息处理护栏：下载/视觉/对话任一环节卡死都不能阻塞轮询。
          await withTimeout(
            handleInboundMessage(msg, options),
            90_000,
            '处理微信消息超时',
          );
        } catch (error) {
          log?.(`[weixin] 处理消息失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      if (signal.aborted) break;
      consecutiveFailures += 1;
      log?.(
        `[weixin] getUpdates 异常（${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}）：${error instanceof Error ? error.message : String(error)}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, signal);
      } else {
        await sleep(RETRY_DELAY_MS, signal);
      }
    }
  }

  await client.notifyStop().catch(() => {});
  log?.(`[weixin] relay stopped`);
  return { stopped: true, staleToken: false };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}（${ms}ms）`)), ms);
    timer.unref?.();
  });
  try {
    return Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
