import type { Tool } from './index.js';
import { type HostResolver, checkUrlHost, safeFetch } from './ssrf.js';

interface WebFetchInput {
  url: string;
  maxChars?: number;
}

export interface WebFetchOptions {
  /** 主机名解析（默认 node:dns）；单测注入避免真实 DNS。 */
  resolveHost?: HostResolver;
  /** 手动跟随的重定向上限（默认 5）。 */
  maxRedirects?: number;
}

function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 流式读取响应体文本，超过 maxBytes 即中断并抛错（避免全量进内存后再判大小）。 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('页面过大（>2MB），已拒绝抓取');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return text;
}

/**
 * web.fetch：抓取网页并提取正文文本（L0 只读）。
 * 吸收 OpenClaw web-fetch 思路：去脚本/样式/标签、压缩空白、截断输出；
 * 只允许 http/https，限制响应大小与输出长度。
 * SSRF（N-P1-8）：DNS 解析后逐个 IP 拒绝回环/私网/链路本地/保留网段，
 * 并用 `redirect: 'manual'` 逐跳重新校验，防止 302 绕过入口检查。
 */
export function createWebFetchTool(
  fetchImpl: typeof fetch = fetch,
  options: WebFetchOptions = {},
): Tool {
  return {
    name: 'web.fetch',
    description:
      '抓取一个网页并提取正文文本（只读 L0）。去掉脚本/样式/标签，' +
      '适合读文章/文档内容；输出最多 8000 字符。只支持 http/https。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 URL（http/https）' },
        maxChars: {
          type: 'number',
          description: '输出上限字符数，默认 8000，最大 20000',
        },
      },
      required: ['url'],
    },
    permissionLevel: 0,
    timeoutMs: 20_000,
    async execute(input: unknown, context) {
      const { url, maxChars = 8000 } = (input ?? {}) as WebFetchInput;
      if (!url?.trim()) return { ok: false, error: '缺少 url 参数' };
      let parsed: URL;
      try {
        parsed = new URL(url.trim());
      } catch {
        return { ok: false, error: 'URL 无效' };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: '只支持 http/https 协议' };
      }
      const capped = Math.min(Math.max(1, Math.floor(maxChars)), 20_000);
      // 入口先做一次校验：协议不对/目标是内网时，连 fetch 都不发。
      const entry = await checkUrlHost(parsed, options.resolveHost);
      if (!entry.ok) return { ok: false, error: entry.error ?? '目标地址不被允许' };
      try {
        const hopped = await safeFetch(
          parsed,
          { signal: context.signal },
          {
            fetchImpl,
            ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
            ...(options.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}),
          },
        );
        if (!hopped.ok) return { ok: false, error: hopped.error };
        const { response, url: finalUrl } = hopped;
        if (!response.ok) {
          return { ok: false, error: `抓取失败：HTTP ${response.status}` };
        }
        const contentType = response.headers.get('content-type') ?? '';
        // 流式限长读取：先 text() 全量进内存再判大小，2MB 上限就形同虚设。
        const text = await readBodyCapped(response, 2_000_000);
        const body = contentType.includes('html')
          ? stripHtml(text)
          : text.replace(/\s+/g, ' ').trim();
        return {
          ok: true,
          data: {
            url: finalUrl.toString(),
            contentType,
            text: body.slice(0, capped),
            truncated: body.length > capped,
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: `抓取失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
