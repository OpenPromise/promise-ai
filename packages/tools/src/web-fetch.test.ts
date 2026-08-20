import { describe, expect, it, vi } from 'vitest';
import { createWebFetchTool } from './web-fetch.js';

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

describe('web.fetch', () => {
  it('提取 HTML 正文并去掉标签/脚本（L0）', async () => {
    const fetchImpl = vi.fn(async () =>
      htmlResponse(
        '<html><head><style>.x{}</style></head><body><script>alert(1)</script><h1>标题</h1><p>正文内容 &amp; 更多</p></body></html>',
      ),
    );
    const tool = createWebFetchTool(fetchImpl);
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
    const tool = createWebFetchTool(fetchImpl);
    const result = await tool.execute({ url: 'file:///etc/passwd' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('http');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('超大页面拒绝抓取', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('x'.repeat(2_000_001)));
    const tool = createWebFetchTool(fetchImpl);
    const result = await tool.execute({ url: 'https://example.com/big' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('2MB');
  });

  it('非 HTML 内容按纯文本返回并截断', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('hello world '.repeat(500), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const tool = createWebFetchTool(fetchImpl);
    const result = await tool.execute(
      { url: 'https://example.com/txt', maxChars: 100 },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    expect((result.data as { text: string }).text.length).toBeLessThanOrEqual(100);
  });
});
