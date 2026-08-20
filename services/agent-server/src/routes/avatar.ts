import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AvatarGenome, AvatarStore } from '@personal-ai/memory';
import {
  applyAvatarDelta,
  APPEARANCE_PARAMS,
  PERSONALITY_PARAMS,
} from '@personal-ai/memory';

export interface AvatarRouteDeps {
  store: AvatarStore;
  /** public/ 静态资源目录（avatar 页面/模型）。 */
  publicDir: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.vrm': 'application/octet-stream',
  '.glb': 'application/octet-stream',
  '.json': 'application/json',
};

/**
 * 可成长 Avatar 服务端（多端统一）：
 * - /avatar：3D 网页（任意设备浏览器打开）
 * - GET /api/avatar/state：基因组
 * - POST /api/avatar/adjust：小步调整外观参数（Phase 2 测试按钮/后续进化应用）
 * - GET /api/avatar/history：成长史
 * - GET /api/avatar/preferences：候选偏好
 * - GET /api/avatar/events：SSE 广播（所有打开的页面同步）
 */
export function registerAvatarRoutes(app: FastifyInstance, deps: AvatarRouteDeps): void {
  const { store } = deps;
  const subscribers = new Set<(genome: AvatarGenome) => void>();

  const broadcast = (genome: AvatarGenome): void => {
    for (const listener of subscribers) {
      try {
        listener(genome);
      } catch {
        // 单个订阅者出错不影响其他
      }
    }
  };

  app.get('/api/avatar/state', async () => {
    const genome = await store.getGenome();
    return { ok: true, data: genome };
  });

  app.get('/api/avatar/history', async (request) => {
    const query = request.query as { limit?: number };
    const events = await store.listEvolutionEvents(
      Math.min(Math.max(1, Math.floor(query.limit ?? 50)), 200),
    );
    return { ok: true, data: { count: events.length, events } };
  });

  app.get('/api/avatar/preferences', async () => {
    const preferences = await store.listPreferences();
    return { ok: true, data: { count: preferences.length, preferences } };
  });

  app.post(
    '/api/avatar/adjust',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            parameter: { type: 'string' },
            delta: { type: 'number' },
            reason: { type: 'string', maxLength: 200 },
          },
          required: ['parameter', 'delta'],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { parameter, delta, reason } = request.body as {
        parameter: string;
        delta: number;
        reason?: string;
      };
      if (
        !APPEARANCE_PARAMS.includes(parameter as (typeof APPEARANCE_PARAMS)[number]) &&
        !PERSONALITY_PARAMS.includes(parameter as (typeof PERSONALITY_PARAMS)[number])
      ) {
        return { ok: false, error: `未知参数：${parameter}` };
      }
      if (typeof delta !== 'number' || !Number.isFinite(delta)) {
        return { ok: false, error: 'delta 必须是数字' };
      }
      const genome = await store.getGenome();
      const applied = applyAvatarDelta(
        genome,
        parameter,
        delta,
        reason?.trim() || '手动调整（Phase 2 测试）',
      );
      if (!applied) {
        return { ok: true, data: { changed: false, genome } };
      }
      await store.saveGenome(applied.genome);
      await store.addEvolutionEvent(applied.event);
      broadcast(applied.genome);
      return {
        ok: true,
        data: {
          changed: true,
          event: applied.event,
          genome: applied.genome,
        },
      };
    },
  );

  app.get('/api/avatar/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    const heartbeat = setInterval(() => {
      reply.raw.write(': keep-alive\n\n');
    }, 15_000);
    heartbeat.unref?.();
    const listener = (genome: AvatarGenome): void => {
      reply.raw.write(`event: avatar.update\ndata: ${JSON.stringify(genome)}\n\n`);
    };
    subscribers.add(listener);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      subscribers.delete(listener);
    });
  });

  // 静态资源：/avatar 页面 + 模型
  app.get('/avatar', async (_request, reply) => {
    const html = await readFile(path.join(deps.publicDir, 'avatar', 'index.html'), 'utf8');
    reply.type('text/html; charset=utf-8').send(html);
  });
  app.get('/avatar/*', async (request, reply) => {
    const file = (request.params as { '*': string })['*'] ?? '';
    const safe = path.normalize(file).replace(/^(\.\.(\/|\\|$))+/, '');
    const full = path.join(deps.publicDir, 'avatar', safe);
    if (!full.startsWith(path.join(deps.publicDir, 'avatar'))) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    try {
      const content = await readFile(full);
      const ext = path.extname(full).toLowerCase();
      reply.type(CONTENT_TYPES[ext] ?? 'application/octet-stream').send(content);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });
}
