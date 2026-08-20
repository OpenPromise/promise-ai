/**
 * 事件推送：订阅 agent-server /api/events（SSE），把提醒（reminder.due）
 * 与定时任务结果（task.run）主动推送到所有已登录的微信对端。
 */
import type { ILinkClient } from './ilink.js';
import { buildReplyMessage } from './ilink.js';
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

export interface EventPusherOptions {
  agentUrl: string;
  client: ILinkClient;
  /** 返回要推送的微信对端列表。 */
  peers: () => string[];
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
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
  return undefined;
}

/** 持续订阅 /api/events 并推送（断线自动重连，指数退避）。 */
export async function runEventPusher(
  options: EventPusherOptions,
  signal: AbortSignal,
): Promise<void> {
  const { agentUrl, client, peers, log } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  let failures = 0;

  while (!signal.aborted) {
    try {
      const response = await fetchImpl(`${agentUrl.replace(/\/+$/, '')}/api/events`, {
        signal,
      });
      if (!response.ok) throw new Error(`events HTTP ${response.status}`);
      failures = 0;
      let currentEvent = '';

      await consumeSse(response, (line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('event:')) {
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
          for (const peer of targets) {
            void client
              .sendMessage(buildReplyMessage({ to: peer, text }))
              .catch((error) =>
                log?.(
                  `[weixin] 推送失败 ${peer}：${error instanceof Error ? error.message : String(error)}`,
                ),
              );
          }
          if (targets.length > 0) {
            log?.(`[weixin] 已推送事件 ${currentEvent} 到 ${targets.length} 个微信对端`);
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
