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
  /** 单轮对话总上限（毫秒）；默认 5 分钟，可用 WEIXIN_CHAT_TIMEOUT_MS 覆盖。 */
  chatTimeoutMs?: number;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

const LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;

/**
 * SSE 单次读取的空闲上限：agent-server 的事件流每 15s 发一个 keep-alive 注释行，
 * 聊天流则持续产出 token，所以 90s 无任何字节只可能是连接已死（TCP 半开 / 容器被杀）。
 */
const SSE_IDLE_TIMEOUT_MS = 90_000;
/**
 * 单轮微信对话的总上限。coding.run / engineer.delegate 这类长任务工具会跑几分钟
 * （coding.run 自身上限 60 分钟，但派单已改异步立即返回），5 分钟足够覆盖同步部分；
 * 超时后必须让 chatOnce 结束、inflightSessions 释放，否则该会话永久失联。
 */
const CHAT_TOTAL_TIMEOUT_MS = 5 * 60_000;

/** 提前推送分段策略常量（见 takeEarlySegment）。 */
const PARAGRAPH_SEPARATOR = '\n\n';
/** 首段最小长度：低于它不提前发，避免「好的。」这类碎片消息刷屏。 */
const FIRST_SEGMENT_MIN_CHARS = 15;
/** 长文本兜底切分时，切点之后的句子至少保留的字数，避免切出碎片。 */
const SEGMENT_MIN_CHARS = 20;
/** 无段落边界时，缓冲超过该长度即按句末标点提前切一次。 */
const FLUSH_THRESHOLD_CHARS = 400;
/**
 * 强句边界（切点在这些标点之后）：中文句号/感叹号/问号、中文省略号。
 * 注意英文句点 `.` 刻意不在其中——数字（3.14 / v1.2.3）、缩写（Mr. / U.S.A.）、
 * 域名（example.com）里的点不是句子结束（LiveKit 假句号保护思路）。
 */
const STRONG_BOUNDARY_CHARS = '。！？!?…';
/** 弱句边界（长文本无强边界时的兜底）：分号/逗号/顿号/冒号（中英）。 */
const WEAK_BOUNDARY_CHARS = '；;，,、：:';

/** 长任务工具白名单：这些工具执行时向微信推送"已派出/已完成"进度节点。 */
const LONG_TASK_TOOLS = ['engineer.delegate', 'coding.run'];
/** 长任务工具开始时的确认文案（程序保证，不依赖模型输出文字）。 */
const TOOL_START_HINTS: Record<string, string> = {
  'engineer.delegate': '🔧 收到，已派给小黑！预计几分钟，干完我验收后向你汇报。',
  'coding.run': '🔧 收到，开始执行开发任务，预计几分钟，完成后向你汇报。',
};

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
  // 首段：达最小长度且有强边界时，切在第一个完整句末（关键节点短消息）。
  // 阈值提高后，「好的。」这类短句不再单发，等 chat.done 一次性发出。
  if (!alreadySentFirst && pending.length >= FIRST_SEGMENT_MIN_CHARS) {
    const end = findFirstStrongBoundary(pending, FIRST_SEGMENT_MIN_CHARS - 1);
    if (end >= 0) {
      const cut = clampToCharBoundary(pending, end + 1);
      return { send: pending.slice(0, cut).trim(), keep: pending.slice(cut) };
    }
  }
  // 长文本兜底：在 400 字符窗口内优先最后一个强边界，其次弱边界
  // （分号/逗号等），再其次空格，最后才硬切。全程 emoji 保护。
  if (pending.length >= FLUSH_THRESHOLD_CHARS) {
    const end = findSegmentBoundary(
      pending,
      SEGMENT_MIN_CHARS - 1,
      true,
      FLUSH_THRESHOLD_CHARS,
    );
    if (end >= 0) {
      const cut = clampToCharBoundary(pending, end + 1);
      return { send: pending.slice(0, cut).trim(), keep: pending.slice(cut) };
    }
    // 空格兜底：避免硬切把单词/数字/URL 拆开。
    const space = pending.lastIndexOf(' ', FLUSH_THRESHOLD_CHARS - 1);
    if (space >= SEGMENT_MIN_CHARS) {
      const cut = clampToCharBoundary(pending, space);
      return { send: pending.slice(0, cut).trim(), keep: pending.slice(cut).trimStart() };
    }
    const cut = clampToCharBoundary(pending, FLUSH_THRESHOLD_CHARS);
    if (cut >= SEGMENT_MIN_CHARS) {
      return { send: pending.slice(0, cut).trim(), keep: pending.slice(cut).trimStart() };
    }
  }
  return undefined;
}

/** 连续三个英文句点（省略号 ...）视作强边界；单个/两个点不是。 */
function isEllipsisAt(text: string, index: number): boolean {
  return (
    text[index] === '.' && index >= 2 && text[index - 1] === '.' && text[index - 2] === '.'
  );
}

/** 查找 >= minIndex 的第一个强边界标点下标。 */
function findFirstStrongBoundary(text: string, minIndex: number): number {
  for (let i = minIndex; i < text.length; i += 1) {
    const ch = text[i]!;
    if (STRONG_BOUNDARY_CHARS.includes(ch) || isEllipsisAt(text, i)) return i;
  }
  return -1;
}

/**
 * 从后往前找最后一个边界标点（>= minIndex）。
 * 优先强边界（。！？!?… 与省略号 ...）；找不到时若 allowWeak 则退回弱边界
 * （；，、：）。英文句点 `.` 永不作为边界（假句号保护）。
 * maxIndex 限定搜索窗口（不越过该下标），保证切出的段长度不会失控。
 */
function findSegmentBoundary(
  text: string,
  minIndex: number,
  allowWeak: boolean,
  maxIndex = text.length,
): number {
  let weak = -1;
  const from = Math.min(text.length, maxIndex) - 1;
  for (let i = from; i >= minIndex; i -= 1) {
    const ch = text[i]!;
    if (STRONG_BOUNDARY_CHARS.includes(ch) || isEllipsisAt(text, i)) return i;
    if (allowWeak && weak < 0 && WEAK_BOUNDARY_CHARS.includes(ch)) weak = i;
  }
  return weak;
}

/**
 * 把切点回退到合法 UTF-16 码点边界：若 index 落在 surrogate pair 中间
 * （低代理项开头），往前退一位，避免拆开 emoji 产生乱码（OpenClaw 思路）。
 */
function clampToCharBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const code = text.charCodeAt(index);
  if (code >= 0xdc00 && code <= 0xdfff) return index - 1;
  return index;
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
    /** 长任务工具开始执行时回调（派单确认：程序保证，不依赖模型输出文字）。 */
    onLongTaskStarted?: (toolName: string) => Promise<void>;
    /** 长任务工具执行完成时回调（进度节点：完成后随 chat.done 发完整报告）。 */
    onLongTaskFinished?: (toolName: string) => Promise<void>;
    /** 单轮对话总上限（默认 5 分钟）；超时后中断 SSE 并返回错误。 */
    totalTimeoutMs?: number;
  } = {},
): Promise<ChatReply> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // 真实超时：自己持有 AbortController 并透传给 fetch 与 consumeSse，
  // 超时/外部取消都会真正断开 HTTP 连接，函数必定返回，
  // 调用方的 inflightSessions 才能释放（否则该会话永久"处理中"）。
  const totalTimeoutMs = options.totalTimeoutMs ?? CHAT_TOTAL_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const totalTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, totalTimeoutMs);
  totalTimer.unref?.();
  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();

  try {
    return await chatOnceInner(agentUrl, sessionId, userMessage, options, controller.signal);
  } catch (error) {
    if (timedOut) {
      return { text: '', error: `对话超过 ${Math.round(totalTimeoutMs / 60_000)} 分钟未完成，已中断` };
    }
    if (controller.signal.aborted) return { text: '', error: '对话已取消' };
    throw error;
  } finally {
    clearTimeout(totalTimer);
    options.signal?.removeEventListener('abort', onExternalAbort);
    // 无论正常结束还是异常，都清掉本会话的待授权登记，避免下条消息被误当审批答复。
    const pending = pendingApprovals.get(sessionId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingApprovals.delete(sessionId);
    }
  }
}

async function chatOnceInner(
  agentUrl: string,
  sessionId: string,
  userMessage: string,
  options: {
    fetchImpl?: typeof fetch;
    log?: (message: string) => void;
    onPermissionRequest?: (info: { requestId: string; toolName: string }) => void;
    onSegment?: (segmentText: string) => Promise<void>;
    onLongTaskStarted?: (toolName: string) => Promise<void>;
    onLongTaskFinished?: (toolName: string) => Promise<void>;
  },
  signal: AbortSignal,
): Promise<ChatReply> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${agentUrl.replace(/\/+$/, '')}/api/sessions/${sessionId}/chat`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: userMessage, requestId: randomUUID() }),
      signal,
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
  let longTaskStartedSent = false;
  const longTaskFinishedIds = new Set<string>();
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
        case 'agent.tool_call': {
          const toolCalls = (envelope.payload as { toolCalls?: Array<{ name?: string }> })
            ?.toolCalls ?? [];
          const longTask = toolCalls.find((call) => call.name && LONG_TASK_TOOLS.includes(call.name));
          if (longTask?.name && !longTaskStartedSent) {
            longTaskStartedSent = true;
            try {
              await options.onLongTaskStarted?.(longTask.name);
            } catch (err) {
              // 派单确认发送失败不阻塞主流程（chat.done 仍会发完整报告）。
              options.log?.(
                `[weixin] 派单确认发送失败：${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          break;
        }
        case 'agent.tool_result': {
          const name = (envelope.payload as { name?: string }).name ?? '';
          const callId = (envelope.payload as { callId?: string }).callId ?? '';
          if (LONG_TASK_TOOLS.includes(name) && callId && !longTaskFinishedIds.has(callId)) {
            longTaskFinishedIds.add(callId);
            try {
              await options.onLongTaskFinished?.(name);
            } catch (err) {
              options.log?.(
                `[weixin] 任务完成推送失败：${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          break;
        }
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
  options: {
    /** 单次读取的空闲上限：超过该时长没有任何数据视为连接已死（默认 90s）。 */
    idleTimeoutMs?: number;
  } = {},
): Promise<void> {
  if (!response.body) return;
  const idleTimeoutMs = options.idleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      // 空闲护栏：TCP 半开（服务端进程被杀 / 网络中断）时 read() 可能永不 resolve，
      // 之前会让微信侧永久失联。两端都会发心跳（chat/events 流每 15s 一个注释行），
      // 所以正常连接不会触发。
      const { done, value } = await withTimeout(
        reader.read(),
        idleTimeoutMs,
        'SSE 连接空闲超时',
      ).catch(async (error: unknown) => {
        await reader.cancel().catch(() => {});
        throw error;
      });
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) await onLine(line);
    }
  } finally {
    // cancel 之后 releaseLock 可能因残留读请求抛错，清理不该掩盖真实错误。
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
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
        ...(options.chatTimeoutMs ? { totalTimeoutMs: options.chatTimeoutMs } : {}),
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
        // 长任务进度节点：派单确认 + 完成提示，让用户知道任务在进行。
        // 失败由 chatOnce 吞掉，完整报告仍会随 chat.done 发出。
        onLongTaskStarted: async (toolName) => {
          await client.sendMessage(
            buildReplyMessage({
              to: peer,
              text:
                TOOL_START_HINTS[toolName] ??
                `🔧 已派出任务：${toolName}，预计几分钟，完成后向你汇报。`,
              contextToken: msg.context_token,
              runId: msg.run_id,
            }),
          );
        },
        onLongTaskFinished: async () => {
          await client.sendMessage(
            buildReplyMessage({
              to: peer,
              text: '✔️ 任务完成，正在整理报告…',
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

/**
 * 超时护栏：`await Promise.race` 之后再清理定时器。
 * 之前写成 `try { return Promise.race(...) } finally { clearTimeout(timer) }`，
 * finally 在返回 Promise 的那一刻就同步执行，定时器立刻被清掉，超时永不触发。
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}（${ms}ms）`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
