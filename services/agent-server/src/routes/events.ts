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
 * （reminder.due / task.run / hook.run / system.boot / engineer.task.done），
 * 为每条分配自增 id；订阅方断线重连时用 Last-Event-ID 拉回错过的通知。
 * 进度（engineer.task.progress）不入缓冲（洪水）。冷启动无 Last-Event-ID
 * 不重放缓冲，避免微信桥重启把旧 done 再推一遍（1a3bf99）。
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
  // 共享事件缓冲 + 活跃连接集。事件源只订阅一次：事件先入缓冲（分配一次 id），
  // 再广播到所有连接——避免"每个连接各自订阅"导致同一事件被重复入缓冲、id 发散。
  const eventBuffer = new SseEventBuffer();
  const connections = new Set<import('node:http').ServerResponse>();
  /**
   * 重启完成通知只广播一次。必须放在路由回调外层：放在回调内是每连接一份局部变量，
   * 永远是 false，于是每个新连接都会再广播一次 boot，已在线的客户端收到 N 份
   * "云服务器重启完成"（微信侧直接转成文字推送）。晚连接的客户端靠 Last-Event-ID 重放补收。
   */
  let bootSent = false;

  const broadcast = (event: string, data: unknown, buffered: boolean): void => {
    const base = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const frame = buffered ? `id: ${eventBuffer.push(event, data)}\n${base}` : base;
    for (const conn of connections) {
      try {
        conn.write(frame);
      } catch {
        // 单个连接写失败不影响其他
      }
    }
  };

  const unsubscribers = [
    deps.subscribeTaskEvents((event) => broadcast('task.run', event, true)),
    deps.subscribeReminderEvents((event) => broadcast('reminder.due', event, true)),
    ...(deps.subscribeHookEvents
      ? [deps.subscribeHookEvents((event) => broadcast('hook.run', event, true))]
      : []),
    ...(deps.subscribeEngineerEvents
      ? [
          deps.subscribeEngineerEvents((event) => {
            const sseEvent =
              event.type === 'done' ? 'engineer.task.done' : 'engineer.task.progress';
            // 完成入缓冲：微信桥 sendMessage 失败后不推进 Last-Event-ID，
            // 断线重连可按 Last-Event-ID 拉回。进度不入缓冲（洪水）。
            broadcast(sseEvent, event, event.type === 'done');
          }),
        ]
      : []),
  ];

  app.get('/api/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    connections.add(reply.raw);

    // 断线重连恢复：仅当请求带 Last-Event-ID 时重放其后的一次性通知。
    // 微信桥进程冷启动没有该头，不重放——否则会把缓冲里旧的
    // engineer.task.done 再推一遍（1a3bf99：同一任务号刷屏）。
    const lastEventIdHeader = request.headers['last-event-id'];
    if (typeof lastEventIdHeader === 'string' && Number.isFinite(Number(lastEventIdHeader))) {
      const lastEventId = Number(lastEventIdHeader);
      for (const record of eventBuffer.replayAfter(lastEventId)) {
        reply.raw.write(
          `id: ${record.id}\nevent: ${record.event}\ndata: ${JSON.stringify(record.data)}\n\n`,
        );
      }
    }

    // 重启完成通知：只有"宿主机真重启"（开机自启）才推送 system.boot，
    // 普通部署/容器重启（宿主机 uptime 很大）不推送。只广播一次，重连客户端靠重放补收。
    if (
      !bootSent &&
      shouldEmitBootNotice(deps.processStartedAt, Date.now(), deps.hostBootedRecently)
    ) {
      bootSent = true;
      broadcast('system.boot', {
        bootedAt: new Date().toISOString(),
        text: '云服务器重启完成，所有服务已自动恢复',
      }, true);
    }

    // 心跳注释行防止代理/网络空闲断开长连接
    const heartbeat = setInterval(() => {
      reply.raw.write(': keep-alive\n\n');
    }, 15_000);
    heartbeat.unref?.();

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      connections.delete(reply.raw);
    });
  });

  // 应用关闭时清理事件源订阅，避免泄漏
  app.addHook('onClose', async () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  });
}
