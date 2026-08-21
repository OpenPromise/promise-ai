import type { FastifyInstance } from 'fastify';
import type { ReminderDueEvent } from '../services/reminder-service.js';
import type { TaskRunEvent } from '../services/task-service.js';
import type { HookRunEvent } from '../services/hook-service.js';
import type { EngineerTaskEvent } from '../services/engineer-task-runner.js';

export interface EventRouteDeps {
  subscribeTaskEvents: (listener: (event: TaskRunEvent) => void) => () => void;
  subscribeReminderEvents: (listener: (event: ReminderDueEvent) => void) => () => void;
  /** 进程启动时间戳：用于重启完成通知（开机自启闭环）。 */
  processStartedAt?: number;
  /**
   * 宿主机是否刚开机（< 10 分钟）。区分"云服务器真重启"与"部署/容器重启"：
   * 只有真重启才发 system.boot 通知，避免每次部署都误报"云服务器重启完成"。
   */
  hostBootedRecently?: boolean;
  /** 外部事件（webhook）处理结果订阅。 */
  subscribeHookEvents?: (listener: (event: HookRunEvent) => void) => () => void;
  /** 小黑后台任务事件订阅（进度/完成）。 */
  subscribeEngineerEvents?: (listener: (event: EngineerTaskEvent) => void) => () => void;
}

/** 进程启动后该时间窗口内，任何事件订阅者都会收到一次 system.boot。 */
const BOOT_NOTICE_WINDOW_MS = 10 * 60 * 1000;

/** 是否应发"云服务器重启完成"通知：宿主机刚开机 且 进程启动不久。 */
export function shouldEmitBootNotice(
  processStartedAt: number | undefined,
  now: number,
  hostBootedRecently: boolean | undefined,
): boolean {
  return (
    Boolean(hostBootedRecently) &&
    processStartedAt !== undefined &&
    now - processStartedAt < BOOT_NOTICE_WINDOW_MS
  );
}

export interface SseEventRecord {
  id: number;
  event: string;
  data: unknown;
}

/**
 * 有界环形事件缓冲（SSE 重放）：只记录一次性通知类事件
 * （reminder.due / task.run / hook.run / engineer.task.done / system.boot），
 * 为每条分配自增 id；订阅方断线重连时用 Last-Event-ID 拉回错过的通知。
 * 进度类高频事件不入缓冲（避免挤掉通知、重放刷屏）。
 */
export class SseEventBuffer {
  readonly #entries: SseEventRecord[] = [];
  #nextId = 1;

  constructor(readonly capacity = 20) {}

  /** 记录并返回新事件 id。 */
  push(event: string, data: unknown): number {
    const id = this.#nextId++;
    this.#entries.push({ id, event, data });
    if (this.#entries.length > this.capacity) this.#entries.shift();
    return id;
  }

  /** 返回 id 大于 lastEventId 的记录（按时间顺序）。 */
  replayAfter(lastEventId: number): SseEventRecord[] {
    return this.#entries.filter((entry) => entry.id > lastEventId);
  }
}

/**
 * Server-Sent Events 推送端点：桌面端常驻订阅，任务执行完成/失败时
 * 立即推送 `task.run` 事件（通知闭环的出口）。
 */
export function registerEventRoutes(app: FastifyInstance, deps: EventRouteDeps): void {
  // 共享事件缓冲：所有 SSE 连接共用一个环形日志，重连后才能拉回错过的通知。
  const eventBuffer = new SseEventBuffer();

  app.get('/api/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    // 断线重连恢复：重放 Last-Event-ID 之后的一次性通知（SSE 标准重放）。
    const lastEventIdHeader = request.headers['last-event-id'];
    const lastEventId =
      typeof lastEventIdHeader === 'string' && Number.isFinite(Number(lastEventIdHeader))
        ? Number(lastEventIdHeader)
        : 0;
    for (const record of eventBuffer.replayAfter(lastEventId)) {
      reply.raw.write(
        `id: ${record.id}\nevent: ${record.event}\ndata: ${JSON.stringify(record.data)}\n\n`,
      );
    }

    const writeBuffered = (event: string, data: unknown): void => {
      const id = eventBuffer.push(event, data);
      reply.raw.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const writeLive = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // 重启完成通知：只有"宿主机真重启"（开机自启）才推送 system.boot，
    // 普通部署/容器重启（宿主机 uptime 很大）不推送，避免误报。
    if (shouldEmitBootNotice(deps.processStartedAt, Date.now(), deps.hostBootedRecently)) {
      writeBuffered('system.boot', {
        bootedAt: new Date().toISOString(),
        text: '云服务器重启完成，所有服务已自动恢复',
      });
    }

    // 心跳注释行防止代理/网络空闲断开长连接
    const heartbeat = setInterval(() => {
      reply.raw.write(': keep-alive\n\n');
    }, 15_000);
    heartbeat.unref?.();

    const unsubscribe = deps.subscribeTaskEvents((event) => {
      writeBuffered('task.run', event);
    });
    const unsubscribeReminders = deps.subscribeReminderEvents((event) => {
      writeBuffered('reminder.due', event);
    });
    const unsubscribeHooks = deps.subscribeHookEvents?.((event) => {
      writeBuffered('hook.run', event);
    });
    const unsubscribeEngineer = deps.subscribeEngineerEvents?.((event) => {
      const sseEvent = event.type === 'done' ? 'engineer.task.done' : 'engineer.task.progress';
      if (event.type === 'done') {
        writeBuffered(sseEvent, event);
      } else {
        writeLive(sseEvent, event);
      }
    });

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribeReminders();
      unsubscribeHooks?.();
      unsubscribeEngineer?.();
    });
  });
}
