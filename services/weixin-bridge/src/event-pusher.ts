/**
 * 事件推送：订阅 agent-server /api/events（SSE），把提醒（reminder.due）
 * 与定时任务结果（task.run）主动推送到所有已登录的微信对端。
 */
import type { ILinkClient } from './ilink.js';
import { buildReplyMessage } from './ilink.js';
import { clipPlainText, markdownToPlain, splitLongText } from './markdown.js';
import { OUTBOX_DRAIN_INTERVAL_MS, type DoneOutbox, type OutboxEntry } from './outbox.js';
import { consumeSse } from './relay.js';

interface ReminderEvent {
  text?: string;
}

interface TaskEvent {
  taskName?: string;
  action?: string;
  status?: string;
  output?: string;
  error?: string;
}

interface HookEvent {
  hookName?: string;
  summary?: string;
  output?: string;
  error?: string;
  status?: string;
}

interface EngineerTaskEvent {
  type?: 'started' | 'progress' | 'done';
  taskId?: string;
  status?: string;
  colleague?: string;
  text?: string;
  result?: string;
  error?: string;
}

export interface EventPusherOptions {
  agentUrl: string;
  client: ILinkClient;
  /** 返回要推送的微信对端列表。 */
  peers: () => string[];
  /** agent-server API 共享 token（AGENT_API_TOKEN）；未配置时不带该头。 */
  apiToken?: string;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
  /** sendMessage 失败后的重试间隔（毫秒）。默认 1s 再 2s，共 3 次尝试。 */
  sendRetryDelaysMs?: number[];
  /** 上次已处理的 SSE id（从 StateStore 恢复，空则不带 Last-Event-ID）。 */
  lastEventId?: string;
  /** lastEventId 前进时回调（用于落盘）。 */
  onLastEventId?: (id: string) => void | Promise<void>;
  /** 未送达的完成通知队列；进度失败不入队。 */
  outbox?: DoneOutbox;
  /** 出队补发间隔。默认 15s。 */
  outboxDrainIntervalMs?: number;
}

export function formatEvent(event: string, data: unknown): string | undefined {
  if (event === 'system.boot') {
    return '✅ 云服务器重启完成，所有服务已自动恢复。';
  }
  if (event === 'reminder.due') {
    const reminder = data as ReminderEvent;
    return `⏰ 提醒：${reminder.text ?? '时间到了'}`;
  }
  if (event === 'task.run') {
    const task = data as TaskEvent;
    const name = task.taskName || task.action || '定时任务';
    const ok = task.status !== 'error';
    const detail = (task.output || task.error || '').toString().slice(0, 300);
    // OpenClaw heartbeat 不打扰协议：任务输出 HEARTBEAT_OK 表示"无事发生"，
    // 静默跳过，不推送给用户（避免定时巡检每轮都刷屏）。
    if (
      ok &&
      (task.output ?? '').toString().trim().toUpperCase().includes('HEARTBEAT_OK')
    ) {
      return undefined;
    }
    return `${ok ? '✅' : '❌'} 定时任务${ok ? '完成' : '失败'}：${name}${detail ? `\n${detail}` : ''}`;
  }
  if (event === 'hook.run') {
    const hook = data as HookEvent;
    const output = (hook.output || hook.error || '').toString().slice(0, 300);
    // 外部事件无需要求打扰（HEARTBEAT_OK）时静默。
    if (
      hook.status !== 'error' &&
      output.trim().toUpperCase().includes('HEARTBEAT_OK')
    ) {
      return undefined;
    }
    return `🔔 外部事件（${hook.hookName ?? 'unknown'}）：${hook.summary ?? ''}${output ? `\n${output}` : ''}`;
  }
  if (event === 'engineer.task.progress') {
    const task = data as EngineerTaskEvent;
    const text = (task.text ?? '').trim();
    // 开工瞬间与「已派给 xxx」重复，等后面有实质进度再冒泡。
    if (task.type === 'started' || /已开工，正在执行任务/.test(text)) {
      return undefined;
    }
    const id = (task.taskId ?? '').slice(0, 8);
    const who = task.colleague || '小黑';
    const body = text || '正在执行';
    return `🔧 ${who}任务进行中${id ? `（#${id}）` : ''}：${body.slice(0, 120)}`;
  }
  if (event === 'engineer.task.done') {
    const task = data as EngineerTaskEvent;
    const id = (task.taskId ?? '').slice(0, 8);
    const who = task.colleague || '小黑';
    const ok = task.status === 'success';
    const raw = (task.result || task.error || '').toString().trim();
    const detail = raw ? clipPlainText(markdownToPlain(raw)) : '';
    // result 已是小夜自己的验收口吻，原样推送，避免再套一层「小夜：xx回来了」。
    if (!detail) {
      return ok
        ? `小夜：${who}回来了。`
        : `❌ 小夜：${who}这单没跑完${id ? `（#${id}）` : ''}。`;
    }
    if (!ok && !/❌|失败|没跑完|没搞定/.test(detail)) {
      return `❌ ${detail}`;
    }
    return detail;
  }
  return undefined;
}

/** sendMessage 失败时的默认重试间隔：第 1 次失败后等 1s，第 2 次失败后等 2s，共 3 次尝试。 */
export const SEND_RETRY_DELAYS_MS = [1000, 2000] as const;

async function sendMessageWithRetry(
  client: ILinkClient,
  peer: string,
  chunk: string,
  log: ((message: string) => void) | undefined,
  signal: AbortSignal,
  retryDelaysMs: readonly number[],
): Promise<boolean> {
  const maxAttempts = retryDelaysMs.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.sendMessage(buildReplyMessage({ to: peer, text: chunk }));
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const delay = retryDelaysMs[attempt - 1];
      if (delay !== undefined && !signal.aborted) {
        log?.(`[weixin] 推送失败 ${peer}（第${attempt}次，将重试）：${detail}`);
        await sleep(delay, signal);
        continue;
      }
      log?.(`[weixin] 推送失败 ${peer}：${detail}`);
      return false;
    }
  }
  return false;
}

async function drainOutbox(
  outbox: DoneOutbox,
  client: ILinkClient,
  log: ((message: string) => void) | undefined,
  signal: AbortSignal,
): Promise<void> {
  const remaining = outbox.peek();
  if (remaining.length === 0) return;
  while (remaining.length > 0 && !signal.aborted) {
    const entry = remaining[0]!;
    try {
      await client.sendMessage(buildReplyMessage({ to: entry.peer, text: entry.text }));
      remaining.shift();
      log?.(`[weixin] 补发完成通知成功`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log?.(`[weixin] 补发完成通知失败：${detail}`);
      break;
    }
  }
  await outbox.replace(remaining);
}

function startOutboxDrainTimer(
  outbox: DoneOutbox,
  client: ILinkClient,
  log: ((message: string) => void) | undefined,
  signal: AbortSignal,
  intervalMs: number,
): void {
  let draining = false;
  const timer = setInterval(() => {
    if (draining || signal.aborted) return;
    draining = true;
    void drainOutbox(outbox, client, log, signal)
      .catch((error) => {
        log?.(
          `[weixin] 出队补发异常：${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        draining = false;
      });
  }, intervalMs);
  timer.unref?.();
  signal.addEventListener(
    'abort',
    () => {
      clearInterval(timer);
    },
    { once: true },
  );
}

/** 持续订阅 /api/events 并推送（断线自动重连，指数退避）。 */
export async function runEventPusher(
  options: EventPusherOptions,
  signal: AbortSignal,
): Promise<void> {
  const { agentUrl, client, peers, log, apiToken, outbox } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelaysMs = options.sendRetryDelaysMs ?? SEND_RETRY_DELAYS_MS;
  let failures = 0;
  /** 最近一次已处理事件的 SSE id：断线重连时回传 Last-Event-ID 拉回错过的通知。 */
  let lastEventId = options.lastEventId ?? '';

  if (outbox && !signal.aborted) {
    try {
      await drainOutbox(outbox, client, log, signal);
    } catch (error) {
      log?.(
        `[weixin] 启动补发失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    startOutboxDrainTimer(
      outbox,
      client,
      log,
      signal,
      options.outboxDrainIntervalMs ?? OUTBOX_DRAIN_INTERVAL_MS,
    );
  }

  while (!signal.aborted) {
    try {
      const response = await fetchImpl(`${agentUrl.replace(/\/+$/, '')}/api/events`, {
        signal,
        headers: {
          ...(apiToken ? { 'x-agent-token': apiToken } : {}),
          ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
        },
      });
      if (!response.ok) throw new Error(`events HTTP ${response.status}`);
      failures = 0;
      let currentEvent = '';
      let currentId = '';

      await consumeSse(response, async (line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('id:')) {
          currentId = trimmed.slice(3).trim();
        } else if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim();
        } else if (trimmed.startsWith('data:')) {
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') return;
          let json: unknown;
          try {
            json = JSON.parse(data) as unknown;
          } catch {
            return;
          }
          const text = formatEvent(currentEvent, json);
          if (!text) return;
          const targets = peers();
          const chunks = splitLongText(text);
          let anyChunkOk = false;
          const failedDone: OutboxEntry[] = [];
          await Promise.all(
            targets.map(async (peer) => {
              for (const chunk of chunks) {
                const ok = await sendMessageWithRetry(
                  client,
                  peer,
                  chunk,
                  log,
                  signal,
                  retryDelaysMs,
                );
                if (ok) {
                  anyChunkOk = true;
                } else if (currentEvent === 'engineer.task.done') {
                  failedDone.push({
                    peer,
                    text: chunk,
                    ts: Date.now(),
                    event: currentEvent,
                  });
                }
              }
            }),
          );
          // 完成通知三次都失败则落入盘队列，并推进 Last-Event-ID，避免重启后
          // SSE 重放与 outbox 补发各送一次。进度失败不入队、不推进。
          let queued = false;
          if (outbox && failedDone.length > 0) {
            for (const entry of failedDone) {
              await outbox.enqueue(entry);
            }
            queued = true;
            log?.(`[weixin] 完成通知入队待重试 ${failedDone.length} 条`);
          }
          // 至少一个 chunk 投递到某个对端成功（或完成通知已入队）才推进 Last-Event-ID。
          if (currentId && (anyChunkOk || queued) && currentId !== lastEventId) {
            lastEventId = currentId;
            await options.onLastEventId?.(lastEventId);
          }
          if (targets.length > 0) {
            if (anyChunkOk) {
              log?.(`[weixin] 已推送事件 ${currentEvent} 到 ${targets.length} 个微信对端`);
            } else {
              log?.(`[weixin] 推送失败（未送达） ${currentEvent}`);
            }
          }
        }
      });
    } catch (error) {
      if (signal.aborted) return;
      failures += 1;
      log?.(
        `[weixin] 事件推送连接断开（${failures}）：${error instanceof Error ? error.message : String(error)}`,
      );
      await sleep(Math.min(1000 * 2 ** Math.min(failures, 5), 30_000), signal);
    }
  }
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
