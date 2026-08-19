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
});
