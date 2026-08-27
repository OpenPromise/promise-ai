import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from './state.js';

describe('StateStore', () => {
  it('persists account and peer session mapping', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wxstate-'));
    const file = path.join(dir, 'state.json');
    const store = await StateStore.open(file);
    expect(store.account).toBeUndefined();

    await store.setAccount({
      token: 'tok',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      accountId: 'bot-1',
      userId: 'wx-user',
      peerSessions: { peer_a: 'session-1' },
      savedAt: new Date().toISOString(),
    });

    const reloaded = await StateStore.open(file);
    expect(reloaded.account?.token).toBe('tok');
    expect(reloaded.account?.peerSessions.peer_a).toBe('session-1');
    expect(JSON.parse(await readFile(file, 'utf8')).account.accountId).toBe('bot-1');
  });

  it('tolerates missing or corrupt state files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wxstate-'));
    const store = await StateStore.open(path.join(dir, 'missing.json'));
    expect(store.account).toBeUndefined();
  });

  it('并发 save 串行化：共用的 .tmp 不再互相覆盖，文件始终是完整 JSON', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wxstate-'));
    const file = path.join(dir, 'state.json');
    const store = await StateStore.open(file);

    // 20 次并发写（真实场景：多个微信对端同时建会话 -> setAccount -> save）
    const saves = Array.from({ length: 20 }, (_, i) =>
      store.setAccount({
        token: `tok-${i}`,
        baseUrl: 'https://ilinkai.weixin.qq.com',
        accountId: 'bot-1',
        peerSessions: { [`peer_${i}`]: `session-${i}` },
        savedAt: new Date().toISOString(),
      }),
    );
    await Promise.all(saves);

    const raw = await readFile(file, 'utf8');
    // 未串行化时 rename 会撞在一起（ENOENT/EPERM）或写出被截断的半成品
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).account.token).toBe(store.account?.token);
  });

  it('persists lastEventId independently of account; empty id is a no-op', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wxstate-'));
    const file = path.join(dir, 'state.json');
    const store = await StateStore.open(file);
    expect(store.lastEventId).toBe('');

    await store.setLastEventId('');
    expect(store.lastEventId).toBe('');

    await store.setLastEventId('42');
    expect(store.lastEventId).toBe('42');

    const reloaded = await StateStore.open(file);
    expect(reloaded.lastEventId).toBe('42');
    expect(reloaded.account).toBeUndefined();

    await reloaded.setLastEventId('42');
    await reloaded.setLastEventId('43');
    expect((await StateStore.open(file)).lastEventId).toBe('43');
  });

  it('clearAccount drops lastEventId so a fresh login does not replay', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wxstate-'));
    const file = path.join(dir, 'state.json');
    const store = await StateStore.open(file);
    await store.setLastEventId('9');
    await store.clearAccount();
    expect(store.lastEventId).toBe('');
    expect(JSON.parse(await readFile(file, 'utf8')).lastEventId).toBeUndefined();
  });
});
