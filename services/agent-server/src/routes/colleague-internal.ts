import type { FastifyInstance } from 'fastify';
import type { ColleagueOffice } from '../services/colleague-office.js';
import type { ColleagueChildEvent } from '../services/colleague-internal.js';

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === ':ffff:127.0.0.1' || ip === '::ffff:127.0.0.1';
}

/**
 * 同事子进程把 progress/done POST 到父进程，复用已有 /api/events SSE。
 * 另需 AGENT_API_TOKEN（走全局 API 鉴权）；再加 loopback 收窄。
 */
export function registerColleagueInternalRoutes(
  app: FastifyInstance,
  deps: { office: ColleagueOffice },
): void {
  app.post('/api/internal/colleague-events', async (request, reply) => {
    if (!isLoopback(request.ip)) {
      return reply.code(403).send({ error: 'internal only' });
    }
    const body = request.body as ColleagueChildEvent | null;
    if (
      !body ||
      (body.type !== 'progress' && body.type !== 'done') ||
      typeof body.taskId !== 'string' ||
      !body.taskId.trim()
    ) {
      return reply.code(400).send({ error: 'invalid colleague event' });
    }
    await deps.office.ingestChildEvent(body);
    return { ok: true };
  });
}
