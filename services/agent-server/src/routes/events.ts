import type { FastifyInstance } from 'fastify';
import type { ReminderDueEvent } from '../services/reminder-service.js';
import type { TaskRunEvent } from '../services/task-service.js';

export interface EventRouteDeps {
  subscribeTaskEvents: (listener: (event: TaskRunEvent) => void) => () => void;
  subscribeReminderEvents: (listener: (event: ReminderDueEvent) => void) => () => void;
  /** 进程启动时间戳：用于重启完成通知（开机自启闭环）。 */
  processStartedAt?: number;
}

/** 进程启动后该时间窗口内，任何事件订阅者都会收到一次 system.boot。 */
const BOOT_NOTICE_WINDOW_MS = 10 * 60 * 1000;

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

    // 重启完成通知：进程刚启动（如云服务器重启后自启）时，推送一次
    // system.boot，微信桥订阅到后转发给所有已绑定对端。
    if (
      deps.processStartedAt !== undefined &&
      Date.now() - deps.processStartedAt < BOOT_NOTICE_WINDOW_MS
    ) {
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

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribeReminders();
    });
  });
}
