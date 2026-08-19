import { describe, expect, it, vi } from 'vitest';
import type { ILinkClient, WeixinMessage } from './ilink.js';
import { chatOnce, consumeSse, runWeixinRelay } from './relay.js';
import type { AccountState } from './state.js';

function sseResponse(lines: string[]): Response {
  return new Response(lines.map((line) => `data: ${line}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('consumeSse', () => {
  it('handles lines split across chunks', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\nda'));
        controller.enqueue(new TextEncoder().encode('ta: {"b":2}\n\n'));
        controller.close();
      },
    });
    const lines: string[] = [];
    await consumeSse(new Response(stream), (line) => lines.push(line));
    expect(lines.filter((line) => line.trim().length > 0)).toEqual([
      'data: {"a":1}',
      'data: {"b":2}',
    ]);
  });
});

describe('chatOnce', () => {
  it('streams tokens and auto-denies permission requests', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/chat')) {
        return sseResponse([
          JSON.stringify({ type: 'chat.token', payload: { delta: '你好' } }),
          JSON.stringify({
            type: 'permission.request',
            payload: { request: { requestId: 'req-1', toolName: 'files.delete' } },
          }),
          JSON.stringify({ type: 'chat.token', payload: { delta: '，世界' } }),
        ]);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const reply = await chatOnce('http://agent:3000', 's1', '你好', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reply.text).toBe('你好，世界');
    expect(reply.deniedTools).toEqual(['files.delete']);
    const permissionCall = calls.find((call) => call.url.includes('/permission'));
    expect(permissionCall).toBeTruthy();
    expect(JSON.parse(permissionCall!.init.body as string)).toMatchObject({
      requestId: 'req-1',
      approved: false,
    });
  });

  it('returns an error note on non-200 chat response', async () => {
    const fetchImpl = vi.fn(async () => new Response('down', { status: 503 }));
    const reply = await chatOnce('http://agent:3000', 's1', 'hi', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reply.error).toContain('503');
  });
});

describe('runWeixinRelay', () => {
  it('relays an inbound message to the agent and sends the reply', async () => {
    const sent: WeixinMessage[] = [];
    const controller = new AbortController();
    let polls = 0;

    const client = {
      baseUrl: 'https://ilinkai.weixin.qq.com',
      async notifyStart() {},
      async notifyStop() {},
      async getUpdates(_buf: string, options: { signal?: AbortSignal }) {
        polls += 1;
        if (polls === 1) {
          return {
            ret: 0,
            get_updates_buf: 'buf-2',
            msgs: [
              {
                from_user_id: 'wx_peer',
                message_type: 1,
                message_state: 2,
                context_token: 'ctx',
                run_id: 'r1',
                item_list: [{ type: 1, text_item: { text: '打开天气' } }],
              },
            ],
          };
        }
        // 第二次轮询等待 abort
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 60_000);
          options.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve(undefined);
          });
        });
        throw new Error('aborted');
      },
      async getConfig() {
        return { ret: 0, typing_ticket: 'ticket' };
      },
      async sendTyping() {},
      async sendMessage(msg: WeixinMessage) {
        sent.push(msg);
      },
    } as unknown as ILinkClient;

    const state: AccountState = {
      token: 'tok',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      accountId: 'bot-1',
      peerSessions: {},
      savedAt: new Date().toISOString(),
    };
    const persist = vi.fn(async () => {});

    const fetchImpl = vi.fn(async (url: string, _init: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/sessions')) {
        return new Response(JSON.stringify({ id: 'session-abc' }), { status: 201 });
      }
      if (u.endsWith('/chat')) {
        return sseResponse([
          JSON.stringify({ type: 'chat.token', payload: { delta: '今天是晴天' } }),
        ]);
      }
      return new Response('{}', { status: 200 });
    });

    const relayPromise = runWeixinRelay(
      {
        agentUrl: 'http://agent:3000',
        client,
        state,
        persist,
        log: () => {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      controller.signal,
    );

    // 等回复发出
    const deadline = Date.now() + 5000;
    while (sent.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to_user_id).toBe('wx_peer');
    expect(sent[0]?.item_list?.[0]?.text_item?.text).toBe('今天是晴天');
    expect(state.peerSessions.wx_peer).toBe('session-abc');
    expect(state.syncBuf).toBe('buf-2');

    controller.abort();
    const result = await relayPromise;
    expect(result.staleToken).toBe(false);
  });
});
