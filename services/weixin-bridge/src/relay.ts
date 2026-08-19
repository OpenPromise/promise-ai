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
  deniedTools: string[];
  error?: string;
}

/** 与 agent-server 完成一轮对话：POST /chat 消费 SSE，权限请求自动拒绝。 */
export async function chatOnce(
  agentUrl: string,
  sessionId: string,
  userMessage: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; log?: (message: string) => void } = {},
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
    return { text: '', deniedTools: [], error: `Agent 服务返回 ${response.status}：${detail}` };
  }

  let text = '';
  const deniedTools: string[] = [];
  let error: string | undefined;
  const denied = new Set<string>();

  const deny = (requestId: string, toolName: string): void => {
    if (denied.has(requestId)) return;
    denied.add(requestId);
    deniedTools.push(toolName || '未知操作');
    void fetchImpl(`${agentUrl.replace(/\/+$/, '')}/api/sessions/${sessionId}/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId,
        approved: false,
        reason: '微信通道默认拒绝，请到桌面端授权',
      }),
    }).catch(() => {});
  };

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
        if (requestId) deny(requestId, toolName);
        break;
      }
      case 'chat.error':
        error = envelope.payload?.error ?? '未知错误';
        break;
    }
  });

  return { text, deniedTools, error };
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

  // 输入中提示（尽力而为）
  try {
    const cfg = await client.getConfig(peer, msg.context_token);
    await client.sendTyping(peer, cfg.typing_ticket, 1);
  } catch {
    // typing 失败不影响主流程
  }

  const reply = await chatOnce(agentUrl, sessionId, userMessage, {
    fetchImpl,
    log,
  });
  const replyParts: string[] = [];
  if (reply.text) replyParts.push(markdownToPlain(reply.text));
  if (reply.deniedTools.length > 0) {
    replyParts.push(
      `⚠️ 已拒绝需要确认的操作：${[...new Set(reply.deniedTools)].join('、')}（可在桌面端授权后重试）`,
    );
  }
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

      if (resp.get_updates_buf !== undefined && resp.get_updates_buf !== '') {
        syncBuf = resp.get_updates_buf;
        state.syncBuf = syncBuf;
        await persist().catch(() => {});
      }
      for (const msg of resp.msgs ?? []) {
        try {
          await handleInboundMessage(msg, options);
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
