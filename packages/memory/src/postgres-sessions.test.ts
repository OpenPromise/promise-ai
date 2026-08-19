import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresSessionStore, SessionNotFoundError } from './index.js';

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)('PostgresSessionStore', () => {
  const store = new PostgresSessionStore({ connectionString: connectionString as string });
  const pool = new pg.Pool({ connectionString });
  const createdIds: string[] = [];

  it('persists sessions across store instances (restart survival)', async () => {
    await store.init();
    const first = new PostgresSessionStore({ connectionString: connectionString as string });
    await first.init();
    const session = await first.createSession({
      systemPrompt: '你是测试助理',
      metadata: { source: 'restart-test' },
    });
    createdIds.push(session.id);
    await first.addMessage(session.id, { role: 'user', content: '你好' });
    await first.close();

    // A brand-new store (simulating an agent-server restart) can read it back.
    const second = new PostgresSessionStore({ connectionString: connectionString as string });
    await second.init();
    const restored = await second.getSession(session.id);
    expect(restored.systemPrompt).toBe('你是测试助理');
    expect(restored.metadata?.source).toBe('restart-test');
    expect(restored.messages.map((message) => message.content)).toEqual(['你好']);
    await second.close();
  });

  it('supports updateSession message replacement and metadata merge', async () => {
    const session = await store.createSession({ metadata: { a: 1 } });
    createdIds.push(session.id);
    await store.addMessage(session.id, { role: 'user', content: '旧消息' });

    const updated = await store.updateSession(session.id, {
      messages: [
        {
          id: 'summary-1',
          sessionId: session.id,
          role: 'user',
          content: '[历史对话摘要] 压缩后',
          createdAt: new Date().toISOString(),
        },
      ],
      metadata: { compacted: true },
    });
    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0]?.content).toBe('[历史对话摘要] 压缩后');
    expect(updated.metadata).toEqual({ a: 1, compacted: true });
  });

  it('throws SessionNotFoundError for unknown ids and lists sessions', async () => {
    await expect(store.getSession('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      SessionNotFoundError,
    );
    const all = await store.listSessions();
    expect(Array.isArray(all)).toBe(true);
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await pool.query('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [createdIds]);
    }
    await store.close();
    await pool.end();
  });
});
