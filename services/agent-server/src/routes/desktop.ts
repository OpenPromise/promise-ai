import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ToolRegistry } from '@personal-ai/tools';
import { DesktopToolBridge } from '../services/desktop-bridge.js';

export interface DesktopRouteDeps {
  registry: ToolRegistry;
  /**
   * 桌面端共享密钥（DESKTOP_TOKEN）。桌面端注册的工具会进入全局
   * ToolRegistry 并被 LLM 直接调用，等于把"任意本机能力"接进代理，
   * 因此这里必须鉴权；未配置时一律拒绝握手（宁可连不上，不可裸奔）。
   */
  token?: string;
}

/** 定长比较，避免用 `===` 逐字符短路泄漏 token 前缀。 */
function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 从 `x-desktop-token` 头或 `?token=` 查询参数取 token（WS 客户端不总能加头）。 */
function readToken(request: FastifyRequest): string {
  const header = request.headers['x-desktop-token'];
  if (typeof header === 'string' && header.length > 0) return header;
  const query = request.query as Record<string, unknown> | undefined;
  const fromQuery = query?.token;
  return typeof fromQuery === 'string' ? fromQuery : '';
}

export function registerDesktopRoutes(app: FastifyInstance, deps: DesktopRouteDeps): void {
  const expected = deps.token?.trim() ?? '';
  app.get(
    '/ws/desktop',
    {
      websocket: true,
      // preValidation 在 WebSocket 升级前执行，返回 reply 即拒绝握手。
      preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
        if (!expected) {
          request.log.warn('[desktop] 拒绝 /ws/desktop：未配置 DESKTOP_TOKEN');
          return reply.code(401).send({ error: 'DESKTOP_TOKEN 未配置，桌面桥接已禁用' });
        }
        if (!tokenMatches(expected, readToken(request))) {
          request.log.warn('[desktop] 拒绝 /ws/desktop：token 不匹配');
          return reply.code(401).send({ error: 'desktop token 不匹配' });
        }
        return undefined;
      },
    },
    (socket) => {
      new DesktopToolBridge(deps.registry, socket);
    },
  );
}
