import { describe, expect, it, vi } from 'vitest';
import { createWebFetchTool } from './web-fetch.js';

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

/** 单测不做真实 DNS：example.com 固定解析到一个公网地址。 */
const publicResolver = async (): Promise<string[]> => ['93.184.216.34'];

describe('web.fetch', () => {
  it('提取 HTML 正文并去掉标签/脚本（L0）', async () => {
    const fetchImpl = vi.fn(async () =>
      htmlResponse(
        '<html><head><style>.x{}</style></head><body><script>alert(1)</script><h1>标题</h1><p>正文内容 &amp; 更多</p></body></html>',
      ),
    );
    const tool = createWebFetchTool(fetchImpl, { resolveHost: publicResolver });
    expect(tool.permissionLevel).toBe(0);
    const result = await tool.execute({ url: 'https://example.com/a' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    const text = (result.data as { text: string }).text;
    expect(text).toContain('标题');
    expect(text).toContain('正文内容 & 更多');
    expect(text).not.toContain('<script');
    expect(text).not.toContain('alert');
  });

  it('拒绝非 http/https 协议', async () => {
    const fetchImpl = vi.fn();
    const tool = createWebFetchTool(fetchImpl, { resolveHost: publicResolver });
    const result = await tool.execute({ url: 'file:///etc/passwd' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('http');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('超大页面拒绝抓取', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('x'.repeat(2_000_001)));
    const tool = createWebFetchTool(fetchImpl, { resolveHost: publicResolver });
    const result = await tool.execute({ url: 'https://example.com/big' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('2MB');
  });

  it('非 HTML 内容按纯文本返回并截断', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('hello world '.repeat(500), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const tool = createWebFetchTool(fetchImpl, { resolveHost: publicResolver });
    const result = await tool.execute(
      { url: 'https://example.com/txt', maxChars: 100 },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    expect((result.data as { text: string }).text.length).toBeLessThanOrEqual(100);
  });
});

describe('web.fetch SSRF 护栏（N-P1-8）', () => {
  it.each([
    ['http://127.0.0.1:5432/', '回环'],
    ['http://169.254.169.254/latest/meta-data/', '云元数据'],
    ['http://10.0.0.1/admin', '私网 10/8'],
    ['http://192.168.1.1/', '私网 192.168/16'],
    ['http://172.16.5.4/', '私网 172.16/12'],
    ['http://[::1]:8080/', 'IPv6 回环'],
    ['http://[fd00::1]/', 'IPv6 ULA'],
    ['http://0.0.0.0:3000/', '本网络'],
  ])('拒绝内网/保留地址字面量：%s（%s）', async (url) => {
    const fetchImpl = vi.fn();
    const tool = createWebFetchTool(fetchImpl, { resolveHost: publicResolver });
    const result = await tool.execute({ url }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('内网');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('公网域名解析到内网地址时拒绝（DNS rebinding / localtest.me 这类）', async () => {
    const fetchImpl = vi.fn();
    const tool = createWebFetchTool(fetchImpl, {
      resolveHost: async () => ['127.0.0.1'],
    });
    const result = await tool.execute(
      { url: 'http://inside.example.com/secret' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('内网');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('多地址中只要有一个是内网就拒绝', async () => {
    const fetchImpl = vi.fn();
    const tool = createWebFetchTool(fetchImpl, {
      resolveHost: async () => ['93.184.216.34', '169.254.169.254'],
    });
    const result = await tool.execute({ url: 'http://mixed.example.com/' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('重定向逐跳校验：302 跳到云元数据被拦下（不能靠 redirect: follow）', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      redirectTo('http://169.254.169.254/latest/meta-data/'),
    );
    const tool = createWebFetchTool(fetchImpl as unknown as typeof fetch, {
      resolveHost: publicResolver,
    });
    const result = await tool.execute({ url: 'https://example.com/redir' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('内网');
    // 第一跳照常请求，但必须是 manual，否则 undici 已经替我们跟过去了
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  it('重定向到公网地址正常跟随', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://example.org/final'))
      .mockResolvedValueOnce(htmlResponse('<p>最终页面</p>'));
    const tool = createWebFetchTool(fetchImpl, { resolveHost: publicResolver });
    const result = await tool.execute({ url: 'https://example.com/start' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect((result.data as { text: string }).text).toContain('最终页面');
    expect((result.data as { url: string }).url).toBe('https://example.org/final');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('重定向次数过多时放弃', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return redirectTo(`https://example.com/hop-${n}`);
    });
    const tool = createWebFetchTool(fetchImpl, { resolveHost: publicResolver });
    const result = await tool.execute({ url: 'https://example.com/loop' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('重定向');
  });

  it('域名解析失败时报错而不是照样请求', async () => {
    const fetchImpl = vi.fn();
    const tool = createWebFetchTool(fetchImpl, {
      resolveHost: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    const result = await tool.execute({ url: 'http://nx.example.com/' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('解析');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
