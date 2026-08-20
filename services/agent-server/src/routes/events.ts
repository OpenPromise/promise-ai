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

/**
 * Server-Sent Events 推送端点：桌面端常驻订阅，任务执行完成/失败时
 * 立即推送 `task.run` 事件（通知闭环的出口）。
 */
export function registerEventRoutes(app: FastifyInstance, deps: EventRouteDeps): void {
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    // 重启完成通知：只有"宿主机真重启"（开机自启）才推送 system.boot，
    // 普通部署/容器重启（宿主机 uptime 很大）不推送，避免误报。
    if (shouldEmitBootNotice(deps.processStartedAt, Date.now(), deps.hostBootedRecently)) {
      reply.raw.write(
        `event: system.boot\ndata: ${JSON.stringify({
          bootedAt: new Date().toISOString(),
          text: '云服务器重启完成，所有服务已自动恢复',
        })}\n\n`,
      );
    }

    // 心跳注释行防止代理/网络空闲断开长连接
    const heartbeat = setInterval(() => {
      reply.raw.write(': keep-alive\n\n');
    }, 15_000);
    heartbeat.unref?.();

    const unsubscribe = deps.subscribeTaskEvents((event) => {
      reply.raw.write(`event: task.run\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const unsubscribeReminders = deps.subscribeReminderEvents((event) => {
      reply.raw.write(`event: reminder.due\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const unsubscribeHooks = deps.subscribeHookEvents?.((event) => {
      reply.raw.write(`event: hook.run\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const unsubscribeEngineer = deps.subscribeEngineerEvents?.((event) => {
      const sseEvent = event.type === 'done' ? 'engineer.task.done' : 'engineer.task.progress';
      reply.raw.write(`event: ${sseEvent}\ndata: ${JSON.stringify(event)}\n\n`);
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
