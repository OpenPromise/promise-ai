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

/** 提前推送分段策略常量（见 takeEarlySegment）。 */
const PARAGRAPH_SEPARATOR = '\n\n';
/** 首段最小长度：低于它不提前发，避免「好的。」这类碎片消息刷屏。 */
const FIRST_SEGMENT_MIN_CHARS = 6;
/** 长文本兜底切分时，切点之后的句子至少保留的字数，避免切出碎片。 */
const SEGMENT_MIN_CHARS = 20;
/** 无段落边界时，缓冲超过该长度即按句末标点提前切一次。 */
const FLUSH_THRESHOLD_CHARS = 400;

export interface ChatReply {
  text: string;
  error?: string;
  /** 已通过 onSegment 提前发送的原始文本前缀（最终发送时需减去，避免重复）。 */
  preflushed?: string;
}

/**
 * 从待发送缓冲中取出一段「已完整、可提前发送」的文本。
 * 规则（按优先级）：
 *   1. 段落边界：出现 \n\n 时，把 \n\n 之前的完整内容整段提前发（尾部半段留缓冲）；
 *   2. 首段：尚未提前发过首条且已积累到最小长度时，切在第一个完整句末，
 *      让「收到，已派给小黑。」这类关键节点短消息立即送达；
 *   3. 长文本兜底：无段落边界但缓冲超过阈值时，从最后一个句末标点切开，
 *      避免长回复全程静默。
 * 不满足任何规则时返回 undefined（继续累积，最终随 chat.done 一次性发出，
 * 保持原有无分段文本的行为不变）。切分只落在句末标点/换行处，不拆半句。
 */
export function takeEarlySegment(
  pending: string,
  alreadySentFirst: boolean,
): { send: string; keep: string } | undefined {
  const para = pending.lastIndexOf(PARAGRAPH_SEPARATOR);
  if (para >= 0) {
    const send = pending.slice(0, para).trim();
    if (send) return { send, keep: pending.slice(para + PARAGRAPH_SEPARATOR.length) };
  }
  if (!alreadySentFirst && pending.length >= FIRST_SEGMENT_MIN_CHARS) {
    const end = findSentenceEnd(pending, FIRST_SEGMENT_MIN_CHARS - 1, false);
    if (end >= 0) {
      return { send: pending.slice(0, end + 1).trim(), keep: pending.slice(end + 1) };
    }
  }
  if (pending.length >= FLUSH_THRESHOLD_CHARS) {
    const end = findSentenceEnd(pending, SEGMENT_MIN_CHARS - 1, true);
    if (end >= 0) {
      return { send: pending.slice(0, end + 1).trim(), keep: pending.slice(end + 1) };
    }
  }
  return undefined;
}

/** 查找 >= minIndex 的第一个句末标点下标（includeNewline 时换行也算边界）。 */
function findSentenceEnd(text: string, minIndex: number, includeNewline: boolean): number {
  const re = includeNewline ? /[。！？!?；;.!?\n]/ : /[。！？!?；;.!?]/;
  for (let i = minIndex; i < text.length; i += 1) {
    if (re.test(text[i]!)) return i;
  }
  return -1;
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
  const t = text
    .trim()
    .replace(/[。！!？?，,、\s]+$/g, '')
    .toLowerCase();
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
    /** 检测到完整段落/句子时回调：提前发送该段。reject 视为发送失败，内容保留到最终补发。 */
    onSegment?: (segmentText: string) => Promise<void>;
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
  let preflushed = '';
  let error: string | undefined;
  let lastRequestId: string | undefined;
  /** 尚未提前发送的原始文本缓冲（始终是 text 的后缀）。 */
  let earlyBuffer = '';
  let alreadySentFirst = false;
  try {
    await consumeSse(response, async (line) => {
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
        case 'chat.token': {
          text += envelope.payload?.delta ?? '';
          earlyBuffer += envelope.payload?.delta ?? '';
          // 段落感知提前推送：完整段落/句子即时发出，避免整段回复攒到最后。
          while (true) {
            const seg = takeEarlySegment(earlyBuffer, alreadySentFirst);
            if (!seg) break;
            alreadySentFirst = true;
            earlyBuffer = seg.keep;
            if (!seg.send) continue;
            try {
              await options.onSegment?.(seg.send);
              preflushed += seg.send;
            } catch (err) {
              // 提前发送失败不阻塞回复：吞掉错误，内容保留到 chat.done 一次性补发。
              options.log?.(
                `[weixin] 提前分段发送失败：${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          break;
        }
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

  return { text, preflushed, error };
}

/** 逐行消费 SSE 响应（跨 chunk 处理半行；onLine 可为异步，逐行 await 保证顺序）。 */
export async function consumeSse(
  response: Response,
  onLine: (line: string) => void | Promise<void>,
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
      for (const line of lines) await onLine(line);
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
        // 段落感知提前推送：完整段落/句子到达即发，不再攒到 chat.done。
        // 失败由 chatOnce 吞掉（内容保留到最终补发），这里直接抛出让其记账。
        onSegment: async (segmentText) => {
          await client.sendMessage(
            buildReplyMessage({
              to: peer,
              text: markdownToPlain(segmentText),
              contextToken: msg.context_token,
              runId: msg.run_id,
            }),
          );
        },
      });
      const replyParts: string[] = [];
      // 已提前发送的前缀不再重复发送，只补发剩余部分。
      const remaining = reply.text.slice(reply.preflushed?.length ?? 0);
      if (remaining.trim()) replyParts.push(markdownToPlain(remaining));
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
          await withTimeout(handleInboundMessage(msg, options), 90_000, '处理微信消息超时');
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
