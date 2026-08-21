import { lookup } from 'node:dns/promises';

/**
 * SSRF 护栏（N-P1-8）：只允许公网 http/https 目标。
 * web.fetch 是 L0（任何通道零确认可用），没有这层校验时
 * `http://169.254.169.254/latest/meta-data/`（云元数据/临时凭据）、
 * `http://127.0.0.1:5432`、`http://10.0.0.0/8` 内网服务都能被读出来，
 * 而且 fetch 自动跟随重定向会让"只校验入口 URL"的做法被 302 绕过。
 */

/** 主机名 → IP 列表；测试可注入，避免单测依赖真实 DNS。 */
export type HostResolver = (hostname: string) => Promise<string[]>;

export const defaultHostResolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
};

function ipv4Blocked(parts: number[]): boolean {
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  if (a === 0) return true; // 0.0.0.0/8「本网络」
  if (a === 10) return true; // 私网
  if (a === 127) return true; // 回环
  if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网
  if (a === 192 && b === 168) return true; // 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF 保留/文档
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试网段
  if (a === 198 && b === 51 && c === 100) return true; // 文档
  if (a === 203 && b === 0 && c === 113) return true; // 文档
  if (a >= 224) return true; // 组播 224/4 + 保留 240/4 + 广播
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;
  return false;
}

function parseIpv4(ip: string): number[] | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (numbers.some((value) => Number.isNaN(value) || value > 255)) return undefined;
  return numbers;
}

/** 是否为不允许访问的 IP（回环/私网/链路本地/保留网段，IPv4 与 IPv6）。 */
export function isBlockedIp(ip: string): boolean {
  const address = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = parseIpv4(address);
  if (v4) return ipv4Blocked(v4);
  if (!address.includes(':')) return true; // 既不是 IPv4 也不是 IPv6：当作不可信
  // IPv4-mapped/compat（::ffff:127.0.0.1）按其 IPv4 部分判定
  const mapped = address.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mapped?.[1]) {
    const inner = parseIpv4(mapped[1]);
    if (inner) return ipv4Blocked(inner);
  }
  const zoneless = address.split('%')[0] ?? address;
  if (zoneless === '::1' || zoneless === '::') return true; // 回环 / 未指定
  if (/^fe[89ab]/.test(zoneless)) return true; // fe80::/10 链路本地
  if (/^f[cd]/.test(zoneless)) return true; // fc00::/7 ULA
  if (/^ff/.test(zoneless)) return true; // ff00::/8 组播
  if (zoneless.startsWith('64:ff9b:')) return true; // NAT64（可映射到内网 v4）
  if (zoneless.startsWith('2002:')) return true; // 6to4（同上）
  if (zoneless.startsWith('100:')) return true; // 100::/64 discard-only
  return false;
}

export interface HostCheckResult {
  ok: boolean;
  error?: string;
}

/**
 * 校验一个 URL 的目标主机：协议白名单 + DNS 解析后逐个 IP 判定。
 * 主机名本身就是 IP 时跳过 DNS（避免多余查询），域名则解析后校验，
 * 拦住 `localtest.me` 这类"解析到 127.0.0.1 的公网域名"。
 */
export async function checkUrlHost(
  url: URL,
  resolveHost: HostResolver = defaultHostResolver,
): Promise<HostCheckResult> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: '只支持 http/https 协议' };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) return { ok: false, error: 'URL 缺少主机名' };
  const literal = parseIpv4(hostname) || hostname.includes(':');
  if (literal) {
    return isBlockedIp(hostname)
      ? { ok: false, error: `拒绝访问内网/保留地址：${hostname}` }
      : { ok: true };
  }
  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch (error) {
    return {
      ok: false,
      error: `域名解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (addresses.length === 0) return { ok: false, error: `域名解析不到地址：${hostname}` };
  const blocked = addresses.find((address) => isBlockedIp(address));
  if (blocked) {
    return { ok: false, error: `拒绝访问内网/保留地址：${hostname} → ${blocked}` };
  }
  return { ok: true };
}

/** 手动跟随重定向的跳数上限（每跳都重新做 SSRF 校验）。 */
export const MAX_REDIRECTS = 5;

/**
 * 逐跳校验的 fetch：`redirect: 'manual'`，每次 Location 都重新走 checkUrlHost，
 * 避免公网 URL 302 到 127.0.0.1 / 169.254.169.254 绕过入口校验。
 */
export async function safeFetch(
  url: URL,
  init: RequestInit,
  options: { fetchImpl?: typeof fetch; resolveHost?: HostResolver; maxRedirects?: number } = {},
): Promise<{ ok: true; response: Response; url: URL } | { ok: false; error: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveHost = options.resolveHost ?? defaultHostResolver;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  let target = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const check = await checkUrlHost(target, resolveHost);
    if (!check.ok) return { ok: false, error: check.error ?? '目标地址不被允许' };
    const response = await fetchImpl(target, { ...init, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) {
      return { ok: true, response, url: target };
    }
    const location = response.headers.get('location');
    if (!location) return { ok: true, response, url: target };
    // 丢弃重定向响应体，避免连接悬挂
    await response.body?.cancel().catch(() => {});
    try {
      target = new URL(location, target);
    } catch {
      return { ok: false, error: `重定向地址无效：${location}` };
    }
  }
  return { ok: false, error: `重定向次数超过 ${maxRedirects} 次，已放弃` };
}
