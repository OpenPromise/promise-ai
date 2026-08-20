import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { TimelineStore, WorldStore } from '@personal-ai/memory';
import type { WorldActivityKind } from '@personal-ai/memory';
import type { WorldEventBus } from '../services/world-events.js';
import type { WorldService } from '../services/world-service.js';

export interface WorldRouteDeps {
  store: WorldStore;
  service: WorldService;
  timeline?: TimelineStore;
  /** public/ 静态资源目录（world 页面）。 */
  publicDir: string;
  worldEvents?: WorldEventBus;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

/**
 * 「她的世界」路由：
 * - /world：她的房间网页（任意设备浏览器打开）
 * - GET /api/avatar/world：世界状态（位置/活动/天数）
 * - GET /api/avatar/world/events：今日活动流（timeline type=world）
 * - POST /api/avatar/world/act：让她做一件事（手动/测试）
 * - GET /api/avatar/world/stream：SSE 广播（所有打开的页面实时同步）
 */
export function registerWorldRoutes(app: FastifyInstance, deps: WorldRouteDeps): void {
  const { store, service } = deps;
  const bus = deps.worldEvents;

  app.get('/api/avatar/world', async () => {
    const state = await store.getWorld();
    return { ok: true, data: state };
  });

  app.get('/api/avatar/world/events', async (request) => {
    const query = request.query as { limit?: number };
    const events = await deps.timeline?.listEvents({
      type: 'world',
      limit: Math.min(Math.max(1, Math.floor(query.limit ?? 30)), 100),
    });
    return { ok: true, data: { count: events?.length ?? 0, events: events ?? [] } };
  });

  app.post(
    '/api/avatar/world/act',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            label: { type: 'string', maxLength: 60 },
            kind: { type: 'string' },
            emoji: { type: 'string', maxLength: 4 },
            location: { type: 'string', maxLength: 20 },
            durationMin: { type: 'number', minimum: 1, maximum: 240 },
          },
          required: ['label'],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const input = request.body as {
        label: string;
        kind?: string;
        emoji?: string;
        location?: string;
        durationMin?: number;
      };
      const state = await service.act({
        ...input,
        kind: input.kind as WorldActivityKind,
      });
      return { ok: true, data: { applied: true, state } };
    },
  );

  app.get('/api/avatar/world/stream', (request, reply) => {
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
    const listener = (state: unknown): void => {
      reply.raw.write(`event: world.update\ndata: ${JSON.stringify(state)}\n\n`);
    };
    const unsubscribe = bus?.subscribe(listener);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe?.();
    });
  });

  // 静态资源：/world 页面
  app.get('/world', async (_request, reply) => {
    const html = await readFile(path.join(deps.publicDir, 'world', 'index.html'), 'utf8');
    reply.type('text/html; charset=utf-8').send(html);
  });
  app.get('/world/*', async (request, reply) => {
    const file = (request.params as { '*': string })['*'] ?? '';
    const safe = path.normalize(file).replace(/^(\.\.(\/|\\|$))+/, '');
    const full = path.join(deps.publicDir, 'world', safe);
    if (!full.startsWith(path.join(deps.publicDir, 'world'))) {
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
