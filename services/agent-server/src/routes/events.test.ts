import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import { registerEventRoutes, shouldEmitBootNotice, SseEventBuffer } from './events.js';

const NOW = 1_800_000_000_000;

describe('shouldEmitBootNotice（区分真重启 vs 部署/容器重启）', () => {
  it('宿主机刚开机 + 进程启动不久 → 发送通知', () => {
    expect(shouldEmitBootNotice(NOW - 60_000, NOW, true)).toBe(true);
  });

  it('宿主机没重启（部署/容器重启）→ 不发送', () => {
    expect(shouldEmitBootNotice(NOW - 60_000, NOW, false)).toBe(false);
    expect(shouldEmitBootNotice(NOW - 60_000, NOW, undefined)).toBe(false);
  });

  it('宿主机刚开机但进程启动已超 10 分钟 → 不发送（防重连误报）', () => {
    expect(shouldEmitBootNotice(NOW - 11 * 60 * 1000, NOW, true)).toBe(false);
  });
});

describe('SseEventBuffer（断线重连重放）', () => {
  it('push 分配自增 id，replayAfter 只返回更新的记录', () => {
    const buffer = new SseEventBuffer();
    const id1 = buffer.push('reminder.due', { text: '喝水' });
    buffer.push('task.run', { taskName: '备份', status: 'success' });
    expect(id1).toBe(1);

    const replay = buffer.replayAfter(1);
    expect(replay).toHaveLength(1);
    expect(replay[0]?.event).toBe('task.run');
    expect(replay[0]?.id).toBe(2);
    expect(buffer.replayAfter(99)).toEqual([]);
    expect(buffer.replayAfter(0)).toHaveLength(2);
  });

  it('有界环形：超过容量丢弃最旧记录', () => {
    const buffer = new SseEventBuffer(3);
    for (let i = 1; i <= 5; i += 1) buffer.push('task.run', { i });
    const replay = buffer.replayAfter(0);
    expect(replay.map((r) => r.id)).toEqual([3, 4, 5]);
  });
});

/** 读取 SSE 流直到满足条件或超时；返回累计文本。 */
async function readSse(
  url: string,
  until: (text: string) => boolean,
  timeoutMs = 2000,
): Promise<{ text: () => string; close: () => void }> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      /* 连接关闭 */
    }
  })();
  const deadline = Date.now() + timeoutMs;
  while (!until(text) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return {
    text: () => text,
    close: () => {
      controller.abort();
      void pump;
    },
  };
}

describe('registerEventRoutes 的 system.boot 通知', () => {
  it('只广播一次：第二个连接不再触发广播，已在线客户端不会收到重复通知', async () => {
    const app = Fastify({ logger: false });
    registerEventRoutes(app, {
      subscribeTaskEvents: () => () => {},
      subscribeReminderEvents: () => () => {},
      processStartedAt: Date.now(),
      hostBootedRecently: true,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api/events`;

    const countBoot = (text: string): number =>
      text.split('event: system.boot').length - 1;

    const streams: Array<{ close: () => void }> = [];
    try {
      const first = await readSse(url, (text) => countBoot(text) >= 1);
      streams.push(first);
      expect(countBoot(first.text())).toBe(1);

      // 第二个连接：靠 Last-Event-ID 重放拿到那一条 boot，但不能再广播新的一条。
      const second = await readSse(url, (text) => countBoot(text) >= 1);
      streams.push(second);
      expect(countBoot(second.text())).toBe(1);
      // 修复前这里会变成 2（每连接一份 bootSent，广播给所有连接）。
      expect(countBoot(first.text())).toBe(1);
    } finally {
      for (const stream of streams) stream.close();
      await app.close();
    }
  });
});
