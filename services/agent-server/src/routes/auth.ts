import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * API 共享 token 鉴权（N-P0-1）。
 *
 * 部署形态是 agent-server(app:3000) 与 weixin-bridge 两个独立容器，桥要通过
 * compose 网络访问 app:3000——所以不能靠"只监听 127.0.0.1"收窄暴露面，
 * 只能用共享密钥把"第三方绕过对话直接调 API"的面关掉。
 * 微信会话内的文字审批（L2/L3 放行）是产品设计，与本鉴权无关。
 */

/** 免 token 的路径（精确匹配，不做前缀放行，避免 /healthz 之类绕过）。 */
const EXEMPT_PATHS = new Set([
  // 容器 HEALTHCHECK 与 compose 探活都打这里，且不含敏感字段（P1-18 已收窄）。
  '/health',
  // 浏览器直接打开的静态欢迎页，无数据无副作用。
  '/xiaohei',
  '/xiaoyou',
]);

/**
 * 免 token 的路径前缀（只放行子路径）：/xiaohei/avatar.png 等浏览器直取的
 * 静态资源。必须带尾斜杠且逐项前缀匹配，避免 /xiaohei-other 之类被误豁免。
 * 含 .. 段（路径穿越）的请求一律不豁免（见 isAuthExemptPath）。
 */
const EXEMPT_PATH_PREFIXES = ['/xiaohei/', '/xiaoyou/'];

/** hooks 有自己的 HOOK_SECRET + 恒定时间比较，外部系统无法带 API token。 */
const HOOK_PATH_PREFIX = '/api/hooks/';

export type ApiAuthMode = 'token' | 'open' | 'closed';

/** 该请求路径是否免 token。 */
export function isAuthExemptPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  // 路径穿越不豁免：带 .. 段的请求交给路由层处理（静态路由另有 safePath 兜底），
  // 防止 /xiaohei/../api/sessions 之类的拼接借子路径豁免绕过鉴权。
  if (path.split('/').includes('..')) return false;
  if (EXEMPT_PATHS.has(path)) return true;
  // 子路径豁免：/xiaohei/avatar.png、/xiaoyou/** 等静态资源（带尾斜杠前缀，不误伤
  // /xiaohei-other；穿越已在上面拦截）。
  if (EXEMPT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  // /api/hooks/:name —— 必须真有一段 name，且不能再往下钻。
  if (path.startsWith(HOOK_PATH_PREFIX)) {
    const name = path.slice(HOOK_PATH_PREFIX.length);
    return name.length > 0 && !name.includes('/');
  }
  return false;
}

/** 从 `Authorization: Bearer <token>` 或 `x-agent-token` 头取 token。 */
export function extractApiToken(headers: IncomingHttpHeaders): string | undefined {
  const authorization = headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^bearer\s+(.+)$/i.exec(authorization.trim());
    const token = match?.[1]?.trim();
    if (token) return token;
  }
  const direct = headers['x-agent-token'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  return undefined;
}

/**
 * 未配置 token 时怎么办？
 * - 生产环境：拒绝（closed）。容器暴露在公网/内网，裸奔风险最大，宁可起不来也不裸奔。
 * - 开发/测试：放行（open）。否则本地 `npm run dev` 与仓库测试全部 401，属于误伤。
 */
export function resolveApiAuthMode(
  token: string | undefined,
  nodeEnv: 'development' | 'test' | 'production',
): ApiAuthMode {
  if (token) return 'token';
  return nodeEnv === 'production' ? 'closed' : 'open';
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // 长度先比：timingSafeEqual 长度不等会抛。
  return a.length === b.length && timingSafeEqual(a, b);
}

/** WebSocket handler 内校验（升级钩子在 @fastify/websocket 下不可靠）。 */
export function isApiTokenValid(request: FastifyRequest, deps: ApiAuthDeps): boolean {
  const mode = resolveApiAuthMode(deps.token, deps.nodeEnv);
  if (mode === 'open') return true;
  if (mode === 'closed') return false;
  const provided = extractApiToken(request.headers);
  return Boolean(provided && deps.token && tokenMatches(provided, deps.token));
}

export interface ApiAuthDeps {
  token?: string;
  nodeEnv: 'development' | 'test' | 'production';
}

/**
 * 根级 onRequest 钩子：覆盖所有 HTTP 路由，也覆盖 /ws/voice/:sessionId
 * ——@fastify/websocket 的升级请求同样经 fastify.routing() 走完常规钩子。
 */
export function registerApiAuth(app: FastifyInstance, deps: ApiAuthDeps): ApiAuthMode {
  const mode = resolveApiAuthMode(deps.token, deps.nodeEnv);
  if (mode === 'open') return mode;

  app.addHook('onRequest', async (request, reply) => {
    if (isAuthExemptPath(request.url)) return;
    // @fastify/websocket 的升级请求：onRequest 里 reply.send 会挂起（不发 HTTP 响应
    // 也不继续升级），WS 鉴权统一在路由 handler 内做（isApiTokenValid + socket.close）。
    const connection = String(request.headers.connection ?? '').toLowerCase();
    const upgrade = String(request.headers.upgrade ?? '').toLowerCase();
    if (connection.includes('upgrade') && upgrade === 'websocket') return;
    if (mode === 'closed') {
      return reply
        .code(401)
        .send({ error: '生产环境未配置 AGENT_API_TOKEN，API 已禁用（fail closed）' });
    }
    const provided = extractApiToken(request.headers);
    if (!provided || !tokenMatches(provided, deps.token!)) {
      return reply
        .code(401)
        .send({ error: '缺少或错误的 API token（Authorization: Bearer 或 x-agent-token）' });
    }
  });
  return mode;
}
