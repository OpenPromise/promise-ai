import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ILinkClient, WeixinMessage } from './ilink.js';
import {
  approvalWindowMs,
  chatOnce,
  consumeSse,
  parseApprovalText,
  runWeixinRelay,
  takeEarlySegment,
  withTimeout,
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

  it('空闲超时：长时间无数据视为断开并抛错（不再永久挂住）', async () => {
    // 永不产出、永不关闭的流：模拟 TCP 半开
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    await expect(
      consumeSse(new Response(stream), () => {}, { idleTimeoutMs: 40 }),
    ).rejects.toThrow('SSE 连接空闲超时');
  });

  it('心跳注释行会刷新空闲计时（长连接不被误杀）', async () => {
    const enc = new TextEncoder();
    let ticks = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // 每 20ms 一个心跳，共 5 次，空闲阈值 60ms —— 不应超时
        await new Promise((resolve) => setTimeout(resolve, 20));
        ticks += 1;
        if (ticks > 5) {
          controller.enqueue(enc.encode('data: {"done":1}\n\n'));
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(': keep-alive\n\n'));
      },
    });
    const lines: string[] = [];
    await consumeSse(
      new Response(stream),
      (line) => {
        if (line.trim()) lines.push(line.trim());
      },
      { idleTimeoutMs: 60 },
    );
    expect(lines.at(-1)).toBe('data: {"done":1}');
    expect(lines.filter((line) => line.startsWith(': keep-alive')).length).toBeGreaterThan(2);
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

  it('审批窗口按服务端 expiresAt 计时；已过期的请求立即提示超时而不是干等', async () => {
    const asks: Array<{ requestId: string; toolName: string }> = [];
    const timeouts: Array<{ requestId: string; toolName: string }> = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/chat')) {
        return sseResponse([
          JSON.stringify({
            type: 'permission.request',
            payload: {
              request: {
                requestId: 'req-late',
                toolName: 'files.delete',
                // 服务端窗口早已过去（桥接侧比服务端慢/消息积压）
                expiresAt: new Date(Date.now() - 60_000).toISOString(),
              },
            },
          }),
        ]);
      }
      return new Response('{}', { status: 200 });
    });

    await chatOnce('http://agent:3000', 's-late', '删掉它', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onPermissionRequest: (info) => asks.push(info),
      onPermissionTimeout: (info) => timeouts.push(info),
    });

    // 不再向用户要一个注定失效的授权，而是直接告知超时
    expect(asks).toEqual([]);
    expect(timeouts).toEqual([{ requestId: 'req-late', toolName: 'files.delete' }]);
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

  it('preflushedChars 按原始字符数记账：多段提前发送后补发既不重复也不丢字', async () => {
    const segments: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown) =>
      sseResponse([
        JSON.stringify({ type: 'chat.token', payload: { delta: '收到，已派给小黑。\n\n' } }),
        JSON.stringify({ type: 'chat.token', payload: { delta: '第二段开始了。\n\n' } }),
        JSON.stringify({ type: 'chat.token', payload: { delta: '第三段还没完' } }),
      ]),
    );

    const reply = await chatOnce('http://agent:3000', 's1', '查一下', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onSegment: async (segmentText) => {
        segments.push(segmentText);
      },
    });

    expect(segments).toEqual(['收到，已派给小黑。', '第二段开始了。']);
    // 每段都被 trim 掉了尾部的 \n\n：按 send 拼接长度记账会少算 4 个字符，
    // 补发就会把已发过的尾部再发一遍。按原始消费长度记账才对得上。
    expect(reply.preflushedChars).toBe('收到，已派给小黑。\n\n第二段开始了。\n\n'.length);
    expect(reply.text.slice(reply.preflushedChars ?? 0)).toBe('第三段还没完');
  });

  it('提前发送失败后停止分段：失败及之后的内容整段留给最终补发', async () => {
    const segments: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown) =>
      sseResponse([
        JSON.stringify({ type: 'chat.token', payload: { delta: '第一段已经送达。\n\n' } }),
        JSON.stringify({ type: 'chat.token', payload: { delta: '第二段发送会失败。\n\n' } }),
        JSON.stringify({ type: 'chat.token', payload: { delta: '第三段也留到最后。' } }),
      ]),
    );

    const reply = await chatOnce('http://agent:3000', 's1', '查一下', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
      onSegment: async (segmentText) => {
        segments.push(segmentText);
        if (segments.length >= 2) throw new Error('simulated send failure');
      },
    });

    expect(segments).toEqual(['第一段已经送达。', '第二段发送会失败。']);
    expect(reply.preflushedChars).toBe('第一段已经送达。\n\n'.length);
    // 失败的第二段没有被消费，和第三段一起完整留在补发内容里（不重复、不丢失）
    expect(reply.text.slice(reply.preflushedChars ?? 0)).toBe('第二段发送会失败。\n\n第三段也留到最后。');
  });

  it('未提供 onSegment 时不记账，全文都留给调用方一次性发送', async () => {
    const fetchImpl = vi.fn(async (_url: unknown) =>
      sseResponse([
        JSON.stringify({ type: 'chat.token', payload: { delta: '第一段已经写完。\n\n' } }),
        JSON.stringify({ type: 'chat.token', payload: { delta: '第二段也写完了。' } }),
      ]),
    );
    const reply = await chatOnce('http://agent:3000', 's1', '查一下', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reply.preflushedChars).toBe(0);
    expect(reply.text.slice(reply.preflushedChars ?? 0)).toBe(reply.text);
  });
});

describe('approvalWindowMs（P1-16 对齐服务端审批窗口）', () => {
  it('按服务端 expiresAt 计时，并留一点回程余量（不早于服务端过期）', () => {
    const now = Date.now();
    // 服务端说 60s 后过期：桥接侧窗口 >= 60s（不能先于服务端把登记清掉）。
    const win = approvalWindowMs(new Date(now + 60_000).toISOString(), now);
    expect(win).toBeGreaterThanOrEqual(60_000);
    // 也不能离谱地长（服务端已自动拒绝后还挂着等答复）。
    expect(win).toBeLessThanOrEqual(60_000 + 30_000);
  });

  it('没有 expiresAt（旧版服务端）时退回默认窗口，仍不小于服务端 60s', () => {
    expect(approvalWindowMs(undefined, Date.now())).toBeGreaterThanOrEqual(60_000);
  });

  it('expiresAt 非法时退回默认窗口', () => {
    expect(approvalWindowMs('not-a-date', Date.now())).toBeGreaterThanOrEqual(60_000);
  });

  it('expiresAt 已过期（服务端早已自动拒绝）时窗口为 0：立即提示超时，不再干等', () => {
    expect(approvalWindowMs(new Date(Date.now() - 60_000).toISOString(), Date.now())).toBe(0);
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
    expect(takeEarlySegment('已确认收到任务，马上派给小黑处理。接下来我会继续分析项目。', false)).toEqual({
      send: '已确认收到任务，马上派给小黑处理。',
      keep: '接下来我会继续分析项目。',
    });
  });

  it('首段过短、或已提前发过首条时，不提前切（避免碎片刷屏）', () => {
    expect(takeEarlySegment('好的。继续', false)).toBeUndefined();
    expect(takeEarlySegment('收到，已派给小黑。', true)).toBeUndefined();
    // 短首段即使凑够阈值但没有完整句边界，也不提前切
    expect(takeEarlySegment('正在处理中，还没有完整句子', false)).toBeUndefined();
  });

  it('没有任何句末标点时保持缓冲，不提前切', () => {
    expect(takeEarlySegment('没有任何标点的长文本', false)).toBeUndefined();
  });

  it('超过阈值的长文本在 400 字符窗口内按最后边界切分', () => {
    const pending = `${'这是很长的一段话，'.repeat(50)}最后一句。`;
    const seg = takeEarlySegment(pending, true);
    expect(seg).toBeDefined();
    // 每次只切出窗口内内容，send 以完整边界结尾，剩余继续留在缓冲
    expect(seg!.send.endsWith('，')).toBe(true);
    expect(seg!.send.length).toBeLessThanOrEqual(400);
    expect(seg!.send.length).toBeGreaterThanOrEqual(20);
    expect(seg!.keep).toContain('最后一句。');
  });

  it('假句号保护：3.14 / v1.2.3 / Mr. / 域名里的英文点不切断句', () => {
    // 首段场景：句点不在可切范围内时，只能切在中文句号后
    const seg = takeEarlySegment('已确认版本 v1.2.3 和 3.14 都没问题。继续。', false);
    expect(seg?.send).toBe('已确认版本 v1.2.3 和 3.14 都没问题。');
    expect(seg?.keep).toBe('继续。');
    // 兜底场景：整段没有中文句号，只有英文点 + 弱边界，切点落在弱边界而非英文点
    const pending = '数据请看 example.com 与 v1.2.3，'.repeat(40) + '结束';
    const flushed = takeEarlySegment(pending, true);
    expect(flushed).toBeDefined();
    expect(flushed!.send.endsWith('。')).toBe(false);
    expect(flushed!.send.endsWith('.')).toBe(false);
    expect(flushed!.send.endsWith('，')).toBe(true);
  });

  it('省略号（... / …）在兜底切分时是强边界', () => {
    const pending =
      '这是很长的一句话'.repeat(42) + '正在下载安装包…' + '继续继续继续继续继续继续'.repeat(5) + '尾部内容';
    const seg = takeEarlySegment(pending, true);
    expect(seg).toBeDefined();
    expect(seg!.send.endsWith('…')).toBe(true);
    expect(seg!.send.length).toBeLessThanOrEqual(400);
  });

  it('无强边界的长文本退到弱边界（逗号/分号）切分', () => {
    const pending = '这里没有句号，只有逗号，'.repeat(35) + '最后一节';
    const seg = takeEarlySegment(pending, true);
    expect(seg).toBeDefined();
    expect(seg!.send.endsWith('，')).toBe(true);
    expect(seg!.keep.length).toBeGreaterThanOrEqual(20);
  });

  it('硬切兜底不拆开 emoji（UTF-16 代理对保护）', () => {
    const pending = 'a'.repeat(399) + '😀' + 'b'.repeat(30);
    const seg = takeEarlySegment(pending, true);
    expect(seg).toBeDefined();
    expect(seg!.send.length).toBeLessThanOrEqual(400);
    // send 不能以孤立的高代理（emoji 前半）结尾
    expect(/[\uD800-\uDBFF]$/.test(seg!.send)).toBe(false);
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
          // 真实用户是"看到授权提示后"才回复；等提示发出再投递「允许」，
          // 否则这条答复可能早于 permission.request 登记而丢失（与实现无关的竞态）。
          const deadline = Date.now() + 5000;
          while (
            !sent.some((m) => m.text?.includes('需要你的授权')) &&
            Date.now() < deadline
          ) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
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

  it('授权窗口到点后主动告知用户「已超时」，不再静默等一条永远没用的答复', async () => {
    const sent: Array<{ text?: string }> = [];
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
                item_list: [{ type: 1, text_item: { text: '执行删除' } }],
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
      async sendMessage(message: {
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

    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/sessions')) {
        return new Response(JSON.stringify({ id: 'session-approval-timeout' }), { status: 201 });
      }
      if (u.endsWith('/chat')) {
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(
              enc.encode(
                `data: ${JSON.stringify({
                  type: 'permission.request',
                  payload: {
                    request: {
                      requestId: 'req-t',
                      toolName: 'files.delete',
                      // 服务端很快就会自动拒绝：桥接侧窗口按 expiresAt 计时
                      expiresAt: new Date(Date.now() + 100).toISOString(),
                    },
                  },
                })}\n\n`,
              ),
            );
            // 用户始终不回复：流保持打开，由总超时护栏收尾
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
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
        chatTimeoutMs: 6_000,
      },
      controller.signal,
    );

    const deadline = Date.now() + 6000;
    while (!sent.some((m) => m.text?.includes('授权已超时')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(sent.some((m) => m.text?.includes('需要你的授权：files.delete'))).toBe(true);
    expect(sent.some((m) => m.text?.includes('授权已超时'))).toBe(true);

    controller.abort();
    await relayPromise;
  });

  it('对话卡死时 5 分钟护栏生效：会话释放，下一条消息仍能处理（不永久失联）', async () => {
    const sent: Array<{ text?: string }> = [];
    const controller = new AbortController();
    let polls = 0;
    let chatCalls = 0;
    /** 第一路 /chat 的 signal：断言超时后 fetch 真的被 abort。 */
    let firstChatSignal: AbortSignal | undefined;

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
        if (polls === 1) return { ret: 0, get_updates_buf: 'b2', msgs: [msg('第一条')] };
        if (polls === 2) {
          // 等第一轮超时释放后再投递第二条（真实场景是用户过一会儿再发）
          const deadline = Date.now() + 5000;
          while (!sent.some((m) => m.text?.includes('已中断')) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return { ret: 0, get_updates_buf: 'b3', msgs: [msg('第二条')] };
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
        return new Response(JSON.stringify({ id: 'session-timeout' }), { status: 201 });
      }
      if (u.endsWith('/chat')) {
        chatCalls += 1;
        if (chatCalls === 1) {
          firstChatSignal = init.signal ?? undefined;
          // 永不结束、永不产出数据的流：模拟 agent 卡死 / TCP 半开。
          // 真实 fetch 在 signal abort 时会断开 body 流，这里必须模拟同样的行为，
          // 否则 reader.read() 永远挂起，chatOnce 的超时分支无法返回。
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              init.signal?.addEventListener(
                'abort',
                () => controller.error(new DOMException('aborted', 'AbortError')),
                { once: true },
              );
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return new Response(
          `data: ${JSON.stringify({ type: 'chat.token', payload: { delta: '第二轮回复' } })}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
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
        chatTimeoutMs: 150,
      },
      controller.signal,
    );

    const deadline = Date.now() + 8000;
    while (!sent.some((m) => m.text?.includes('第二轮回复')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // 第一轮超时后给出明确提示，而不是静默失联
    expect(sent.some((m) => m.text?.includes('已中断'))).toBe(true);
    // 超时真的断开了 HTTP 连接
    expect(firstChatSignal?.aborted).toBe(true);
    // inflightSessions 已释放：第二条消息没有被"上一条还在处理中"挡掉
    expect(sent.some((m) => m.text?.includes('上一条还在处理中'))).toBe(false);
    expect(sent.some((m) => m.text?.includes('第二轮回复'))).toBe(true);

    controller.abort();
    await relayPromise;
  });
});

describe('agent-server 共享 token（N-P0-1 桥接侧）', () => {
  it('chatOnce 带上 x-agent-token；未配置时不加任何多余头', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string> });
      return sseResponse([JSON.stringify({ type: 'chat.token', payload: { delta: 'ok' } })]);
    });

    await chatOnce('http://agent:3000', 's1', '你好', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      apiToken: 'tok-agent',
    });
    expect(calls[0]?.headers['x-agent-token']).toBe('tok-agent');

    calls.length = 0;
    await chatOnce('http://agent:3000', 's1', '你好', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(calls[0]?.headers['x-agent-token']).toBeUndefined();
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('relay 的建会话与审批答复也带 token', async () => {
    const controller = new AbortController();
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    let polls = 0;
    const sent: Array<{ text?: string }> = [];

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
        if (polls === 1) return { ret: 0, get_updates_buf: 'buf-2', msgs: [msg('你好') ] };
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
      calls.push({ url: u, headers: (init.headers ?? {}) as Record<string, string> });
      if (u.endsWith('/api/sessions')) {
        return new Response(JSON.stringify({ id: 'session-tok' }), { status: 201 });
      }
      if (u.endsWith('/chat')) {
        return sseResponse([JSON.stringify({ type: 'chat.token', payload: { delta: '好' } })]);
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
        apiToken: 'tok-agent',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      controller.signal,
    );

    const deadline = Date.now() + 6000;
    while (!sent.some((m) => m.text?.includes('好')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    await relayPromise;

    const sessionCall = calls.find((call) => call.url.endsWith('/api/sessions'));
    expect(sessionCall?.headers['x-agent-token']).toBe('tok-agent');
    const chatCall = calls.find((call) => call.url.endsWith('/chat'));
    expect(chatCall?.headers['x-agent-token']).toBe('tok-agent');
  });
});

describe('withTimeout', () => {
  it('超时真正触发（clearTimeout 不再在 race 决出前被同步调用）', async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 30, '测试超时')).rejects.toThrow('测试超时');
  });

  it('先完成的 promise 正常返回，不受超时影响', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, '测试超时')).resolves.toBe('ok');
  });
});
