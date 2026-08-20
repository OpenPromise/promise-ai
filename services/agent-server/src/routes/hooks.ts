import type { FastifyInstance } from 'fastify';
import type { HookService } from '../services/hook-service.js';

export interface HookRouteDeps {
  hooks: HookService;
  /** 共享密钥（可选）：配置后请求需带 x-hook-secret 头。 */
  secret?: string;
}

/**
 * 事件驱动监听入口：POST /api/hooks/:name
 * 外部系统（GitHub webhook、监控告警等）把事件推进来，HookService
 * 异步评估/处理，结果经 /api/events 推送到微信等渠道。立即返回 200。
 */
export function registerHookRoutes(app: FastifyInstance, deps: HookRouteDeps): void {
  app.post(
    '/api/hooks/:name',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 64 },
          },
          required: ['name'],
        },
      },
    },
    async (request, reply) => {
      const params = request.params as { name: string };
      const hookName = params.name.trim();
      if (!hookName) {
        return reply.code(400).send({ error: 'hook name 不能为空' });
      }
      if (deps.secret) {
        const provided = request.headers['x-hook-secret'];
        if (typeof provided !== 'string' || provided !== deps.secret) {
          return reply.code(401).send({ error: 'x-hook-secret 不匹配' });
        }
      }
      const payload = request.body ?? {};
      // 立即返回，异步处理，避免外部系统重试堆积。
      void deps.hooks.handle(hookName, payload);
      return reply.code(200).send({ accepted: true, hook: hookName });
    },
  );
}
