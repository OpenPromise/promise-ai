import { describe, expect, it } from 'vitest';
import { shouldEmitBootNotice } from './events.js';

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
