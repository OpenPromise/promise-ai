import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ILinkClient, WeixinMessage } from './ilink.js';
import {
  chatOnce,
  consumeSse,
  parseApprovalText,
  runWeixinRelay,
  takeEarlySegment,
} from './relay.js';
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
    await consumeSse(new Response(stream), (line) => {
      lines.push(line);
    });
    expect(lines.filter((line) => line.trim().length > 0)).toEqual([
      'data: {"a":1}',
      'data: {"b":2}',
    ]);
  });
});

describe('chatOnce', () => {
  it('streams tokens and routes permission requests to WeChat text approval', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const asks: Array<{ requestId: string; toolName: string }> = [];
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
      onPermissionRequest: (info) => asks.push(info),
    });
    expect(reply.text).toBe('你好，世界');
    // 不再自动拒绝：把请求交给微信文字审批（onPermissionRequest 回调）
    expect(asks).toEqual([{ requestId: 'req-1', toolName: 'files.delete' }]);
    expect(calls.some((call) => call.url.includes('/permission'))).toBe(false);
  });

  it('returns an error note on non-200 chat response', async () => {
    const fetchImpl = vi.fn(async () => new Response('down', { status: 503 }));
    const reply = await chatOnce('http://agent:3000', 's1', 'hi', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reply.error).toContain('503');
  });

  it('长任务工具（engineer.delegate）派单时触发 onLongTaskStarted 确认', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown) =>
      sseResponse([
        JSON.stringify({
          type: 'agent.tool_call',
          payload: {
            toolCalls: [
              { id: 'call_1', name: 'engineer.delegate', arguments: '{"task":"修复登录"}' },
            ],
          },
        }),
        JSON.stringify({
          type: 'agent.tool_result',
          payload: { callId: 'call_1', name: 'engineer.delegate', result: { ok: true } },
        }),
        JSON.stringify({
          type: 'chat.token',
          payload: { delta: '小黑已完成：修复登录。' },
        }),
      ]),
    );

    const reply = await chatOnce('http://agent:3000', 's1', '派活', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onLongTaskStarted: async (name) => {
        started.push(name);
      },
      onLongTaskFinished: async (name) => {
        finished.push(name);
      },
    });
    expect(started).toEqual(['engineer.delegate']);
    expect(finished).toEqual(['engineer.delegate']);
    expect(reply.text).toBe('小黑已完成：修复登录。');
  });

  it('coding.run 同样触发派单确认；轻量工具不触发', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown) =>
      sseResponse([
        JSON.stringify({
          type: 'agent.tool_call',
          payload: { toolCalls: [{ id: 'c1', name: 'filesystem.read', arguments: '{}' }] },
        }),
        JSON.stringify({
          type: 'agent.tool_call',
          payload: { toolCalls: [{ id: 'c2', name: 'coding.run', arguments: '{}' }] },
        }),
        JSON.stringify({
          type: 'agent.tool_result',
          payload: { callId: 'c1', name: 'filesystem.read', result: { ok: true } },
        }),
        JSON.stringify({
          type: 'agent.tool_result',
          payload: { callId: 'c2', name: 'coding.run', result: { ok: true } },
        }),
        JSON.stringify({ type: 'chat.done', payload: { text: '完成' } }),
      ]),
    );

    await chatOnce('http://agent:3000', 's1', '干活', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onLongTaskStarted: async (name) => {
        started.push(name);
      },
      onLongTaskFinished: async (name) => {
        finished.push(name);
      },
    });
    // filesystem.read 不触发，只有 coding.run 触发一次
    expect(started).toEqual(['coding.run']);
    expect(finished).toEqual(['coding.run']);
  });

  it('同一轮多个长任务调用只推送一次派单确认', async () => {
    const started: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown) =>
      sseResponse([
        JSON.stringify({
          type: 'agent.tool_call',
          payload: {
            toolCalls: [
              { id: 'c1', name: 'engineer.delegate', arguments: '{}' },
              { id: 'c2', name: 'coding.run', arguments: '{}' },
            ],
          },
        }),
        JSON.stringify({ type: 'chat.done', payload: { text: '完成' } }),
      ]),
    );

    await chatOnce('http://agent:3000', 's1', '干活', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onLongTaskStarted: async (name) => {
        started.push(name);
      },
    });
    expect(started).toEqual(['engineer.delegate']);
  });
});

describe('parseApprovalText', () => {
  it('识别允许/拒绝关键词', () => {
    expect(parseApprovalText('允许')).toBe('allow');
    expect(parseApprovalText('可以。')).toBe('allow');
    expect(parseApprovalText('OK')).toBe('allow');
    expect(parseApprovalText('拒绝')).toBe('deny');
    expect(parseApprovalText('不要')).toBe('deny');
    expect(parseApprovalText('no')).toBe('deny');
    expect(parseApprovalText('帮我看看')).toBeUndefined();
    expect(parseApprovalText('')).toBeUndefined();
  });
});

describe('takeEarlySegment', () => {
  it('按 \\n\\n 段落边界提前切出完整段落，尾部半段留缓冲', () => {
    expect(takeEarlySegment('第一段\n\n第二段，未完', false)).toEqual({
      send: '第一段',
      keep: '第二段，未完',
    });
    expect(takeEarlySegment('收到，已派给小黑。\n\n', false)).toEqual({
      send: '收到，已派给小黑。',
      keep: '',
    });
  });

  it('首段达最小长度且有句末标点时，切在第一个完整句末（关键节点短消息）', () => {
    expect(takeEarlySegment('收到，已派给小黑。接下来我会继续。', false)).toEqual({
      send: '收到，已派给小黑。',
      keep: '接下来我会继续。',
    });
  });

  it('首段过短、或已提前发过首条时，不提前切（避免碎片刷屏）', () => {
    expect(takeEarlySegment('好的。继续', false)).toBeUndefined();
    expect(takeEarlySegment('收到，已派给小黑。', true)).toBeUndefined();
  });

  it('没有任何句末标点时保持缓冲，不提前切', () => {
    expect(takeEarlySegment('没有任何标点的长文本', false)).toBeUndefined();
  });

  it('超过阈值的长文本按最后一个句末标点切分', () => {
    const pending = `${'这是很长的一段话，'.repeat(50)}最后一句。`;
    const seg = takeEarlySegment(pending, true);
    expect(seg).toBeDefined();
    expect(seg!.send).toBe(pending);
    expect(seg!.keep).toBe('');
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

    const relayCalls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, _init: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/sessions')) {
        relayCalls.push({ url: u, body: (_init.body as string) ?? '' });
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
    expect(JSON.parse(relayCalls[0]!.body ?? '').metadata).toEqual({ weixinPeer: 'wx_peer' });

    controller.abort();
    const result = await relayPromise;
    expect(result.staleToken).toBe(false);
  });

  it('downloads inbound images, describes them and relays the description', async () => {
    const sent: WeixinMessage[] = [];
    const controller = new AbortController();
    let polls = 0;
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const client = {
      baseUrl: 'https://ilinkai.weixin.qq.com',
      async notifyStart() {},
      async notifyStop() {},
      async getUpdates(_buf: string, options: { signal?: AbortSignal }) {
        polls += 1;
        if (polls === 1) {
          return {
            ret: 0,
            msgs: [
              {
                from_user_id: 'wx_peer',
                message_type: 1,
                item_list: [
                  {
                    type: 2,
                    image_item: {
                      media: { encrypt_query_param: 'PARAM', aes_key: 'AQIDBA==' },
                    },
                  },
                ],
              },
            ],
          };
        }
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
      async downloadMedia() {
        return Buffer.concat([PNG_MAGIC, Buffer.from('img')]);
      },
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
    let chatBody: { message?: string } | undefined;

    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/sessions')) {
        return new Response(JSON.stringify({ id: 'session-img' }), { status: 201 });
      }
      if (u.endsWith('/chat')) {
        chatBody = JSON.parse((init.body as string) ?? '{}') as { message?: string };
        return sseResponse([
          JSON.stringify({ type: 'chat.token', payload: { delta: '收到，图片已看懂' } }),
        ]);
      }
      if (u.includes('dashscope.aliyuncs.com')) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '一只小猫在窗台上' } }] }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const relayPromise = runWeixinRelay(
      {
        agentUrl: 'http://agent:3000',
        client,
        state,
        persist: async () => {},
        vision: {
          apiKey: 'sk-test',
          model: 'qwen3.8-max',
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
        log: () => {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      controller.signal,
    );

    const deadline = Date.now() + 5000;
    while ((!chatBody || !sent.length) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(chatBody?.message).toContain('[用户发来一张图片]');
    expect(chatBody?.message).toContain('一只小猫在窗台上');
    expect(sent[0]?.item_list?.[0]?.text_item?.text).toBe('收到，图片已看懂');

    controller.abort();
    await relayPromise;
  });

  it('saves inbound files to the library and relays a note', async () => {
    const sent: WeixinMessage[] = [];
    const controller = new AbortController();
    let polls = 0;
    const filesDir = await mkdtemp(path.join(tmpdir(), 'wxrelay-files-'));

    const client = {
      baseUrl: 'https://ilinkai.weixin.qq.com',
      async notifyStart() {},
      async notifyStop() {},
      async getUpdates(_buf: string, options: { signal?: AbortSignal }) {
        polls += 1;
        if (polls === 1) {
          return {
            ret: 0,
            msgs: [
              {
                from_user_id: 'wx_peer',
                message_type: 1,
                item_list: [
                  {
                    type: 4,
                    file_item: {
                      file_name: '报告.pdf',
                      media: { encrypt_query_param: 'PARAM', aes_key: 'AQIDBA==' },
                    },
                  },
                ],
              },
            ],
          };
        }
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
      async downloadMedia() {
        return Buffer.from('pdf-bytes');
      },
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
    let chatBody: { message?: string } | undefined;

    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/sessions')) {
        return new Response(JSON.stringify({ id: 'session-file' }), { status: 201 });
      }
      if (u.endsWith('/chat')) {
        chatBody = JSON.parse((init.body as string) ?? '{}') as { message?: string };
        return sseResponse([
          JSON.stringify({ type: 'chat.token', payload: { delta: '文件已收到' } }),
        ]);
      }
      return new Response('{}', { status: 200 });
    });

    const relayPromise = runWeixinRelay(
      {
        agentUrl: 'http://agent:3000',
        client,
        state,
        persist: async () => {},
        filesDir,
        log: () => {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      controller.signal,
    );

    const deadline = Date.now() + 5000;
    while ((!chatBody || !sent.length) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(chatBody?.message).toContain('[用户发来文件：报告.pdf');
    expect(chatBody?.message).toContain('已保存到文件库');
    expect(sent[0]?.item_list?.[0]?.text_item?.text).toBe('文件已收到');

    controller.abort();
    await relayPromise;
  });

  it('多段落回复：完整段落提前发送，剩余在 chat.done 补发', async () => {
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
                item_list: [{ type: 1, text_item: { text: '查一下任务' } }],
              },
            ],
          };
        }
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

    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/sessions')) {
        return new Response(JSON.stringify({ id: 'session-abc' }), { status: 201 });
      }
      if (u.endsWith('/chat')) {
        return sseResponse([
          JSON.stringify({ type: 'chat.token', payload: { delta: '收到，已派给小黑。' } }),
          JSON.stringify({ type: 'chat.token', payload: { delta: '\n\n我正在处理' } }),
          JSON.stringify({ type: 'chat.token', payload: { delta: '，请稍候。' } }),
        ]);
      }
      return new Response('{}', { status: 200 });
    });

    const relayPromise = runWeixinRelay(
      {
        agentUrl: 'http://agent:3000',
        client,
        state,
        persist: vi.fn(async () => {}),
        log: () => {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      controller.signal,
    );

    // 等两段都发出：首段提前发，剩余在 chat.done 补发
    const deadline = Date.now() + 5000;
    while (sent.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const texts = sent.map((m) => m.item_list?.[0]?.text_item?.text);
    expect(texts).toEqual(['收到，已派给小黑。', '我正在处理，请稍候。']);

    controller.abort();
    await relayPromise;
  });

  it('提前分段发送失败不影响最终送达（内容补发，不重复）', async () => {
    const sent: WeixinMessage[] = [];
    const controller = new AbortController();
    let polls = 0;
    let sendCalls = 0;

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
                item_list: [{ type: 1, text_item: { text: '查一下任务' } }],
              },
            ],
          };
        }
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
        sendCalls += 1;
        // 第一次（提前分段发送）失败，之后（最终补发）成功
        if (sendCalls === 1) throw new Error('simulated send failure');
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

    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/sessions')) {
        return new Response(JSON.stringify({ id: 'session-abc' }), { status: 201 });
      }
      if (u.endsWith('/chat')) {
        return sseResponse([
          JSON.stringify({ type: 'chat.token', payload: { delta: '收到，已派给小黑。' } }),
          JSON.stringify({ type: 'chat.token', payload: { delta: '\n\n最终结果。' } }),
        ]);
      }
      return new Response('{}', { status: 200 });
    });

    const relayPromise = runWeixinRelay(
      {
        agentUrl: 'http://agent:3000',
        client,
        state,
        persist: vi.fn(async () => {}),
        log: () => {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      controller.signal,
    );

    // 提前发送失败被吞掉，最终一次性补发全部内容（不重复、不丢失）
    const deadline = Date.now() + 5000;
    while (sent.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]?.item_list?.[0]?.text_item?.text).toBe('收到，已派给小黑。\n\n最终结果。');
    expect(sendCalls).toBe(2);

    controller.abort();
    await relayPromise;
  });

  it('微信文字审批：授权请求 → 询问 → 用户回复允许 → 继续执行并回复', async () => {
    const sent: Array<{ text?: string }> = [];
    const controller = new AbortController();
    let polls = 0;
    let releaseChat: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseChat = resolve;
    });
    const permissionCalls: Array<{ approved: boolean }> = [];

    const client = {
      baseUrl: 'https://ilinkai.weixin.qq.com',
      async notifyStart() {},
      async notifyStop() {},
      async getUpdates(_buf: string, options: { signal?: AbortSignal }) {
        polls += 1;
        const msg = (text: string) => ({
          from_user_id: 'wx_peer',
          message_type: 1,
          message_state: 2,
          context_token: 'ctx',
          run_id: `r${polls}`,
          item_list: [{ type: 1, text_item: { text } }],
        });
        if (polls === 1) {
          return { ret: 0, get_updates_buf: 'buf-2', msgs: [msg('执行删除')] };
        }
        if (polls === 2) {
          return { ret: 0, get_updates_buf: 'buf-3', msgs: [msg('允许')] };
        }
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
      async sendMessage(message: {
        to_user_id?: string;
        item_list?: Array<{ text_item?: { text?: string } }>;
      }) {
        sent.push({ text: message.item_list?.[0]?.text_item?.text });
      },
    } as unknown as ILinkClient;

    const state: AccountState = {
      token: 'tok',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      accountId: 'bot-1',
      peerSessions: {},
      savedAt: new Date().toISOString(),
    };

    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/sessions')) {
        return new Response(JSON.stringify({ id: 'session-abc' }), { status: 201 });
      }
      if (u.endsWith('/chat')) {
        // SSE 在权限请求处阻塞，直到 /permission 被调用才继续
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ type: 'chat.token', payload: { delta: '需要确认：' } })}\n\n`,
              ),
            );
            streamController.enqueue(
              enc.encode(
                `data: ${JSON.stringify({
                  type: 'permission.request',
                  payload: { request: { requestId: 'req-9', toolName: 'files.delete' } },
                })}\n\n`,
              ),
            );
            void gate.then(() => {
              streamController.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({ type: 'chat.token', payload: { delta: '已执行' } })}\n\n`,
                ),
              );
              streamController.close();
            });
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (u.includes('/permission')) {
        const body = JSON.parse(String(init.body)) as { approved: boolean };
        permissionCalls.push({ approved: body.approved });
        releaseChat?.();
      }
      return new Response('{}', { status: 200 });
    });

    const relayPromise = runWeixinRelay(
      {
        agentUrl: 'http://agent:3000',
        client,
        state,
        persist: vi.fn(async () => {}),
        log: () => {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      controller.signal,
    );

    const deadline = Date.now() + 6000;
    while (
      (permissionCalls.length === 0 || !sent.some((m) => m.text?.includes('已执行'))) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(permissionCalls).toEqual([{ approved: true }]);
    expect(sent.some((m) => m.text?.includes('需要你的授权：files.delete'))).toBe(true);
    expect(sent.some((m) => m.text?.includes('已执行'))).toBe(true);

    controller.abort();
    await relayPromise;
  });
});
