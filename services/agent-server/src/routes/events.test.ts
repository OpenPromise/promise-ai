import { describe, expect, it } from 'vitest';
import { shouldEmitBootNotice, SseEventBuffer } from './events.js';

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
