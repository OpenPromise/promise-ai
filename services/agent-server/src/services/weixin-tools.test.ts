import { describe, expect, it, vi } from 'vitest';
import { InMemorySessionStore } from '@personal-ai/memory';
import { createWeixinTools } from './weixin-tools.js';

async function makeStore(peer?: string): Promise<InMemorySessionStore> {
  const store = new InMemorySessionStore();
  await store.createSession({ metadata: peer ? { weixinPeer: peer } : {} });
  return store;
}

describe('微信通道权限约束', () => {
  it('所有 weixin.* 工具权限必须 ≤ L1（微信通道自动拒绝 L2/L3）', () => {
    const tools = createWeixinTools({
      bridgeUrl: 'http://weixin-bridge:3100',
      store: new InMemorySessionStore(),
    });
    for (const tool of tools) {
      expect(tool.name).toMatch(/^weixin\./);
      expect(tool.permissionLevel, `${tool.name} 在微信通道不可用`).toBeLessThanOrEqual(1);
    }
  });
});

describe('weixin.send_image', () => {
  it('loads a URL image and posts it to the bridge for the session peer', async () => {
    const store = await makeStore('wx_peer');
    const session = (await store.listSessions())[0]!;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.startsWith('http://img'))
        return new Response(new Uint8Array([9, 8, 7]), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const tools = createWeixinTools({
      bridgeUrl: 'http://weixin-bridge:3100',
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await tools
      .find((t) => t.name === 'weixin.send_image')!
      .execute({ source: 'http://img.example/pic.png' }, { sessionId: session.id });
    expect(result.ok).toBe(true);
    const bridgeCall = calls.find((call) => call.url.includes('/api/weixin/send-image'));
    expect(bridgeCall).toBeTruthy();
    const body = JSON.parse(bridgeCall!.init.body as string);
    expect(body.sessionId).toBe(session.id);
    expect(Buffer.from(body.imageBase64, 'base64')).toEqual(Buffer.from([9, 8, 7]));
  });

  it('rejects when the session is not a weixin session', async () => {
    const store = await makeStore();
    const session = (await store.listSessions())[0]!;
    const tools = createWeixinTools({ bridgeUrl: 'http://b:3100', store });
    const result = await tools
      .find((t) => t.name === 'weixin.send_image')!
      .execute({ source: 'http://img.example/pic.png' }, { sessionId: session.id });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不是微信会话');
  });
});

describe('weixin.list_files', () => {
  it('lists the bridge file library', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/weixin/files')) {
        return new Response(
          JSON.stringify({
            count: 2,
            files: [
              { name: '报告.pdf', size: 10, modifiedAt: '' },
              { name: 'notes.txt', size: 4, modifiedAt: '' },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });
    const tools = createWeixinTools({
      bridgeUrl: 'http://weixin-bridge:3100',
      store: await makeStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await tools
      .find((t) => t.name === 'weixin.list_files')!
      .execute({}, { sessionId: 's' });
    expect(result.ok).toBe(true);
    expect((result.data as { count: number }).count).toBe(2);
  });
});

describe('weixin.delete_file', () => {
  it('posts fileName to the bridge delete endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, fileName: '到底丢失了几只羊.pptx' }), {
        status: 200,
      });
    });
    const tools = createWeixinTools({
      bridgeUrl: 'http://weixin-bridge:3100',
      store: await makeStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await tools
      .find((t) => t.name === 'weixin.delete_file')!
      .execute({ fileName: '到底丢失了几只羊' }, { sessionId: 's' });
    expect(result.ok).toBe(true);
    const call = calls.find((c) => c.url.includes('/api/weixin/delete-file'))!;
    expect(JSON.parse(call.init.body as string)).toEqual({ fileName: '到底丢失了几只羊' });
  });

  it('surfaces bridge errors', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: '文件库中找不到「羊」' }), { status: 404 }),
    );
    const tools = createWeixinTools({
      bridgeUrl: 'http://weixin-bridge:3100',
      store: await makeStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await tools
      .find((t) => t.name === 'weixin.delete_file')!
      .execute({ fileName: '羊' }, { sessionId: 's' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('找不到');
  });
});

describe('weixin.send_file', () => {
  it('starts an async background send via the bridge', async () => {
    const store = await makeStore('wx_peer');
    const session = (await store.listSessions())[0]!;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          ok: true,
          jobId: 'job-1',
          status: 'queued',
          fileName: '报告.pdf',
          size: 9,
        }),
        { status: 200 },
      );
    });
    const tools = createWeixinTools({
      bridgeUrl: 'http://weixin-bridge:3100',
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await tools
      .find((t) => t.name === 'weixin.send_file')!
      .execute({ fileName: '报告.pdf' }, { sessionId: session.id });
    expect(result.ok).toBe(true);
    const call = calls.find((c) => c.url.includes('/api/weixin/send-file-async'))!;
    expect(JSON.parse(call.init.body as string)).toMatchObject({
      sessionId: session.id,
      fileName: '报告.pdf',
    });
    expect((result.data as { jobId: string }).jobId).toBe('job-1');
  });

  it('works from non-weixin sessions (bridge falls back to the bound account)', async () => {
    const store = await makeStore();
    const session = (await store.listSessions())[0]!;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, sent: '菜单.psd', size: 28 }), {
        status: 200,
      });
    });
    const tools = createWeixinTools({
      bridgeUrl: 'http://weixin-bridge:3100',
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await tools
      .find((t) => t.name === 'weixin.send_file')!
      .execute({ fileName: '菜单.psd' }, { sessionId: session.id });
    expect(result.ok).toBe(true);
    const call = calls.find((c) => c.url.includes('/api/weixin/send-file-async'))!;
    expect(JSON.parse(call.init.body as string).sessionId).toBe(session.id);
  });
});
