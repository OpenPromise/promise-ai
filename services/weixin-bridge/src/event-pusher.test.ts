import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatEvent, runEventPusher, SEND_RETRY_DELAYS_MS } from './event-pusher.js';

describe('formatEvent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('formats reminder.due', () => {
    expect(formatEvent('reminder.due', { text: '喝水' })).toBe('⏰ 提醒：喝水');
    expect(formatEvent('reminder.due', {})).toBe('⏰ 提醒：时间到了');
  });

  it('formats task.run success and error', () => {
    expect(formatEvent('task.run', { taskName: '备份', status: 'success', output: 'ok' })).toBe(
      '✅ 定时任务完成：备份\nok',
    );
    expect(formatEvent('task.run', { action: '清理', status: 'error', error: '磁盘满' })).toBe(
      '❌ 定时任务失败：清理\n磁盘满',
    );
  });

  it('HEARTBEAT_OK 静默跳过（不打扰协议）', () => {
    expect(
      formatEvent('task.run', { taskName: '服务器巡检', status: 'success', output: 'HEARTBEAT_OK' }),
    ).toBeUndefined();
    expect(
      formatEvent('task.run', {
        taskName: '服务器巡检',
        status: 'success',
        output: '磁盘使用率 95%，需要处理',
      }),
    ).toContain('磁盘使用率');
  });

  it('formats system.boot（云服务器重启完成通知）', () => {
    expect(formatEvent('system.boot', { text: '云服务器重启完成' })).toBe(
      '✅ 云服务器重启完成，所有服务已自动恢复。',
    );
  });

  it('formats engineer.task.progress（小黑后台进度）', () => {
    expect(
      formatEvent('engineer.task.progress', {
        type: 'progress',
        taskId: '12345678-aaaa',
        status: 'running',
        text: '正在跑测试',
      }),
    ).toBe('🔧 小黑任务进行中（#12345678）：正在跑测试');
  });

  it('formats engineer.task.done success and failure', () => {
    expect(
      formatEvent('engineer.task.done', {
        type: 'done',
        taskId: '12345678-aaaa',
        status: 'success',
        result: '小黑把 typecheck 跑通了，这单可以收。',
      }),
    ).toBe('小黑把 typecheck 跑通了，这单可以收。');
    expect(
      formatEvent('engineer.task.done', {
        type: 'done',
        taskId: '12345678-aaaa',
        status: 'failed',
        result: '小黑卡在编译，要不要再派一单？',
      }),
    ).toBe('❌ 小黑卡在编译，要不要再派一单？');
    expect(
      formatEvent('engineer.task.done', {
        type: 'done',
        taskId: '12345678-aaaa',
        status: 'failed',
        result: '小夜：小黑这单没跑完（#12345678）。\n编译失败',
      }),
    ).toBe('小夜：小黑这单没跑完（#12345678）。\n编译失败');
  });


  it('engineer.task.done 不再套一层「小夜：谁回来了」', () => {
    const out = formatEvent('engineer.task.done', {
      colleague: '小知',
      status: 'success',
      result: '小知把竞品表交来了，要点清楚。要再派跟我说。',
    });
    expect(out).toBe('小知把竞品表交来了，要点清楚。要再派跟我说。');
    expect(out).not.toContain('小夜：小知回来了');
  });

  it('engineer.task.done 把 markdown 表格转成可读纯文本，不含分隔行', () => {
    const result = [
      '## 巡检结果',
      '',
      '| 容器 | 状态 |',
      '|---|---|',
      '| assistant-app | Up 6 min |',
    ].join('\n');
    const out = formatEvent('engineer.task.done', {
      taskId: 'abcdef01-xxxx',
      colleague: '小优',
      status: 'success',
      result,
    });
    expect(out).not.toContain('小夜：小优回来了。');
    expect(out).toContain('巡检结果');
    expect(out).toContain('容器：assistant-app，状态：Up 6 min');
    expect(out).not.toContain('|---|');
    expect(out).not.toContain('| 容器');
  });

  it('skips 开工瞬间进度（与已派给确认重复）', () => {
    expect(
      formatEvent('engineer.task.progress', {
        type: 'started',
        taskId: 'c3c10a62-xxxx',
        colleague: '小优',
        text: '小优已开工，正在执行任务',
      }),
    ).toBeUndefined();
    expect(
      formatEvent('engineer.task.progress', {
        colleague: '小优',
        text: '小优已开工，正在执行任务',
      }),
    ).toBeUndefined();
  });

  it('formats colleague-named progress/done（小优/小美）', () => {
    expect(
      formatEvent('engineer.task.progress', {
        taskId: 'abcdef01-xxxx',
        colleague: '小优',
        text: '正在重启容器',
      }),
    ).toBe('🔧 小优任务进行中（#abcdef01）：正在重启容器');
    expect(
      formatEvent('engineer.task.done', {
        taskId: 'abcdef01-xxxx',
        colleague: '小美',
        status: 'success',
        result: '【DESIGN_SPEC】完成',
      }),
    ).toBe('【DESIGN_SPEC】完成');
  });

  it('ignores unknown events', () => {
    expect(formatEvent('something.else', {})).toBeUndefined();
  });

  it('断线重连时携带 Last-Event-ID，拉回错过的通知', async () => {
    const encoder = new TextEncoder();
    const first = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'id: 1\nevent: reminder.due\ndata: {"text":"喝水"}\n\nid: 2\nevent: task.run\ndata: {"taskName":"备份","status":"success"}\n\n',
            ),
          );
          controller.close();
        },
      }),
      { status: 200 },
    );
    const second = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('id: 3\nevent: reminder.due\ndata: {"text":"睡觉"}\n\n'));
          controller.close();
        },
      }),
      { status: 200 },
    );
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ headers });
      if (calls.length === 1) return first;
      if (calls.length === 2) return second;
      // 第三次及以后：挂起直到测试 abort，模拟长连接存活
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted');
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = {
      async sendMessage(message: { to: string; text: string }) {
        return message;
      },
    } as never;
    const runPromise = runEventPusher(
      {
        agentUrl: 'http://agent:3000',
        client,
        peers: () => ['wx_peer'],
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
      controller.signal,
    );
    // 等前两次连接消费完（含重连）后再终止
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    controller.abort();
    await runPromise.catch(() => {});

    // 第一次连接无 Last-Event-ID；处理后 lastEventId=2，重连携带该值
    expect(Object.keys(calls[0]?.headers ?? {})).toHaveLength(0);
    expect(calls[1]?.headers).toEqual({ 'Last-Event-ID': '2' });
  });

  it('配置 apiToken 时 /api/events 带上 x-agent-token（与 Last-Event-ID 并存）', async () => {
    const encoder = new TextEncoder();
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push({ headers: (init?.headers ?? {}) as Record<string, string> });
      if (calls.length === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(
                encoder.encode('id: 7\nevent: reminder.due\ndata: {"text":"喝水"}\n\n'),
              );
              streamController.close();
            },
          }),
          { status: 200 },
        );
      }
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted');
    });

    const client = {
      async sendMessage(message: { to: string; text: string }) {
        return message;
      },
    } as never;
    const runPromise = runEventPusher(
      {
        agentUrl: 'http://agent:3000',
        client,
        peers: () => ['wx_peer'],
        apiToken: 'tok-agent',
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    controller.abort();
    await runPromise.catch(() => {});

    expect(calls[0]?.headers).toEqual({ 'x-agent-token': 'tok-agent' });
    expect(calls[1]?.headers).toEqual({ 'x-agent-token': 'tok-agent', 'Last-Event-ID': '7' });
  });

  it('长事件按 chunk 发送；任一 chunk 成功即推进 Last-Event-ID', async () => {
    const encoder = new TextEncoder();
    const sent: string[] = [];
    const controller = new AbortController();
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const longText = Array.from({ length: 20 }, (_, i) => `第${i}行：${'字'.repeat(120)}`).join('\n');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push({ headers: (init?.headers ?? {}) as Record<string, string> });
      if (calls.length === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(
                encoder.encode(
                  `id: 9\nevent: reminder.due\ndata: ${JSON.stringify({ text: longText })}\n\n`,
                ),
              );
              streamController.close();
            },
          }),
          { status: 200 },
        );
      }
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted');
    });

    const client = {
      async sendMessage(message: { item_list?: Array<{ text_item?: { text?: string } }> }) {
        sent.push(message.item_list?.[0]?.text_item?.text ?? '');
        return message;
      },
    } as never;
    const runPromise = runEventPusher(
      {
        agentUrl: 'http://agent:3000',
        client,
        peers: () => ['wx_peer'],
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    controller.abort();
    await runPromise.catch(() => {});

    expect(sent.length).toBeGreaterThan(1);
    expect(sent.join('')).toContain('第0行');
    expect(sent.join('')).toContain('第19行');
    expect(calls[1]?.headers).toEqual({ 'Last-Event-ID': '9' });
  });
});


describe('runEventPusher 投递重试', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('默认重试间隔是 1s 再 2s（共 3 次尝试）', () => {
    expect(SEND_RETRY_DELAYS_MS).toEqual([1000, 2000]);
  });

  it('sendMessage 失败两次后第三次成功：重试并记已推送，推进 Last-Event-ID', async () => {
    const encoder = new TextEncoder();
    const logs: string[] = [];
    const controller = new AbortController();
    const calls: Array<{ headers?: Record<string, string> }> = [];
    let sendAttempts = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push({ headers: (init?.headers ?? {}) as Record<string, string> });
      if (calls.length === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(
                encoder.encode('id: 11\nevent: reminder.due\ndata: {"text":"喝水"}\n\n'),
              );
              streamController.close();
            },
          }),
          { status: 200 },
        );
      }
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted');
    });

    const client = {
      async sendMessage(message: { to?: string }) {
        sendAttempts += 1;
        if (sendAttempts < 3) {
          throw new Error('sendMessage ret=-2 errmsg=prepare failed');
        }
        return message;
      },
    } as never;

    const runPromise = runEventPusher(
      {
        agentUrl: 'http://agent:3000',
        client,
        peers: () => ['wx_peer'],
        fetchImpl: fetchMock as unknown as typeof fetch,
        log: (m) => logs.push(m),
        sendRetryDelaysMs: [5, 5],
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    controller.abort();
    await runPromise.catch(() => {});

    expect(sendAttempts).toBe(3);
    expect(logs.some((line) => line.includes('已推送事件 reminder.due'))).toBe(true);
    expect(logs.some((line) => line.includes('推送失败（未送达）'))).toBe(false);
    expect(calls[1]?.headers).toEqual({ 'Last-Event-ID': '11' });
  });

  it('sendMessage 三次都失败：记推送失败（未送达），不记已推送，不推进 Last-Event-ID', async () => {
    const encoder = new TextEncoder();
    const logs: string[] = [];
    const controller = new AbortController();
    const calls: Array<{ headers?: Record<string, string> }> = [];
    let sendAttempts = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push({ headers: (init?.headers ?? {}) as Record<string, string> });
      if (calls.length === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(
                encoder.encode('id: 12\nevent: reminder.due\ndata: {"text":"喝水"}\n\n'),
              );
              streamController.close();
            },
          }),
          { status: 200 },
        );
      }
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted');
    });

    const client = {
      async sendMessage() {
        sendAttempts += 1;
        throw new Error('sendMessage ret=-2 errmsg=prepare failed');
      },
    } as never;

    const runPromise = runEventPusher(
      {
        agentUrl: 'http://agent:3000',
        client,
        peers: () => ['wx_peer'],
        fetchImpl: fetchMock as unknown as typeof fetch,
        log: (m) => logs.push(m),
        sendRetryDelaysMs: [5, 5],
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    controller.abort();
    await runPromise.catch(() => {});

    expect(sendAttempts).toBe(3);
    expect(logs.some((line) => line.includes('已推送'))).toBe(false);
    expect(
      logs.some((line) => line.includes('推送失败（未送达）') && line.includes('reminder.due')),
    ).toBe(true);
    expect(calls[1]?.headers ?? {}).not.toHaveProperty('Last-Event-ID');
  });
});
