import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * weixin-bridge 自身端点的共享 token 鉴权（N-P1-9）。
 *
 * 桥暴露的是"直接给微信对端发消息 / 读删文件库"的能力，比 agent-server 更敏感，
 * 所以除探活与扫码登录链路外全部要 `x-bridge-token`（或 Authorization: Bearer），
 * 且未配置 BRIDGE_TOKEN 时直接拒绝——不允许裸奔。
 *
 * 放在独立模块里是因为 index.ts 有顶层 await 与副作用，vitest 无法 import。
 */

/**
 * 免鉴权路径（精确匹配）：
 * - `/health`：compose healthcheck 与 Dockerfile HEALTHCHECK 用 curl 打这里，
 *   拿不到共享密钥；返回的只有登录态布尔值与 accountId。
 * - `/weixin/login` 与三个 login 端点：运维在浏览器里扫码，此时页面里的 JS
 *   不可能持有服务端共享密钥（写进 HTML 等于公开）。登录本身还要手机扫码 +
 *   手机确认，攻击者拿不到二维码的手机侧确认就无法登录成功。
 */
const EXEMPT_PATHS = new Set(['/health', '/weixin/login', '/api/weixin/login']);

const LOGIN_PREFIX = '/api/weixin/login/';

export function isBridgeAuthExemptPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  if (EXEMPT_PATHS.has(path)) return true;
  if (path.startsWith(LOGIN_PREFIX)) {
    // /api/weixin/login/:key 与 /api/weixin/login/:key/verify
    const rest = path.slice(LOGIN_PREFIX.length);
    if (!rest || rest.includes('..')) return false;
    const segments = rest.split('/');
    if (segments.length === 1) return segments[0]!.length > 0;
    return segments.length === 2 && segments[0]!.length > 0 && segments[1] === 'verify';
  }
  return false;
}

/** 从 `x-bridge-token` 或 `Authorization: Bearer <token>` 取 token。 */
export function extractBridgeToken(headers: IncomingHttpHeaders): string | undefined {
  const direct = headers['x-bridge-token'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const authorization = headers.authorization;
  if (typeof authorization === 'string') {
    const token = /^bearer\s+(.+)$/i.exec(authorization.trim())?.[1]?.trim();
    if (token) return token;
  }
  return undefined;
}

export type BridgeAuthResult = { ok: true } | { ok: false; status: 401; error: string };

export function checkBridgeAuth(input: {
  url: string;
  headers: IncomingHttpHeaders;
  token?: string;
}): BridgeAuthResult {
  if (isBridgeAuthExemptPath(input.url)) return { ok: true };
  if (!input.token) {
    return { ok: false, status: 401, error: 'BRIDGE_TOKEN 未配置，桥端点已禁用' };
  }
  const provided = extractBridgeToken(input.headers);
  if (!provided) {
    return { ok: false, status: 401, error: '缺少 x-bridge-token 头' };
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(input.token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: 'x-bridge-token 不匹配' };
  }
  return { ok: true };
}
