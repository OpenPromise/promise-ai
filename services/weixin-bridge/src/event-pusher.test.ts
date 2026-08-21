import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatEvent, runEventPusher } from './event-pusher.js';

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
        result: '【验证结果】typecheck 通过',
      }),
    ).toBe('✅ 小黑任务完成（#12345678）\n【验证结果】typecheck 通过');
    expect(
      formatEvent('engineer.task.done', {
        type: 'done',
        taskId: '12345678-aaaa',
        status: 'failed',
        error: '编译失败',
      }),
    ).toBe('❌ 小黑任务失败（#12345678）\n编译失败');
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
});
