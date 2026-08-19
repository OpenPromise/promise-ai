import { describe, expect, it, vi } from 'vitest';
import { InMemorySessionStore } from '@personal-ai/memory';
import type { TTSProvider } from '@personal-ai/elevenlabs';
import { createWeixinTools } from './weixin-tools.js';

async function makeStore(peer?: string): Promise<InMemorySessionStore> {
  const store = new InMemorySessionStore();
  await store.createSession({ metadata: peer ? { weixinPeer: peer } : {} });
  return store;
}

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

describe('weixin.send_voice', () => {
  it('synthesizes TTS and posts mp3 to the bridge', async () => {
    const store = await makeStore('wx_peer');
    const session = (await store.listSessions())[0]!;
    const tts: TTSProvider = {
      configured: true,
      async *synthesize() {
        yield { data: Buffer.from('mp3-part-1') };
        yield { data: Buffer.from('-mp3-part-2') };
      },
    };
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const tools = createWeixinTools({
      bridgeUrl: 'http://weixin-bridge:3100',
      store,
      tts: () => tts,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await tools
      .find((t) => t.name === 'weixin.send_voice')!
      .execute({ text: '你好，我是你的助理' }, { sessionId: session.id });
    expect(result.ok).toBe(true);
    const bridgeCall = calls.find((call) => call.url.includes('/api/weixin/send-voice'));
    expect(bridgeCall).toBeTruthy();
    const body = JSON.parse(bridgeCall!.init.body as string);
    expect(Buffer.from(body.audioBase64, 'base64').toString()).toBe('mp3-part-1-mp3-part-2');
    expect(body.encodeType).toBe(7);
  });

  it('fails when TTS is not configured', async () => {
    const store = await makeStore('wx_peer');
    const session = (await store.listSessions())[0]!;
    const tools = createWeixinTools({ bridgeUrl: 'http://b:3100', store, tts: () => undefined });
    const result = await tools
      .find((t) => t.name === 'weixin.send_voice')!
      .execute({ text: 'hi' }, { sessionId: session.id });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未配置 TTS');
  });
});
