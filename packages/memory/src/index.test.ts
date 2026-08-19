import { describe, expect, it } from 'vitest';
import { InMemorySessionStore, SessionNotFoundError } from './index.js';

describe('InMemorySessionStore', () => {
  it('creates and retrieves a session', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({
      systemPrompt: 'you are a personal assistant',
    });
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.messages).toEqual([]);

    const fetched = await store.getSession(session.id);
    expect(fetched.systemPrompt).toBe('you are a personal assistant');
  });

  it('appends messages and updates updatedAt', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession();
    await store.addMessage(session.id, { role: 'user', content: '你好' });
    await store.addMessage(session.id, { role: 'assistant', content: '你好，有什么可以帮你？' });

    const updated = await store.getSession(session.id);
    expect(updated.messages).toHaveLength(2);
    expect(updated.messages[0]?.role).toBe('user');
    expect(updated.messages[1]?.content).toBe('你好，有什么可以帮你？');
    expect(updated.updatedAt >= session.updatedAt).toBe(true);
  });

  it('throws SessionNotFoundError for unknown sessions', async () => {
    const store = new InMemorySessionStore();
    await expect(store.getSession('missing')).rejects.toThrow(SessionNotFoundError);
  });

  it('replaces messages and merges metadata via updateSession', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession({ metadata: { source: 'test' } });
    await store.addMessage(session.id, { role: 'user', content: '你好' });

    const updated = await store.updateSession(session.id, {
      messages: [
        {
          id: 'summary-1',
          sessionId: session.id,
          role: 'user',
          content: '[历史对话摘要] 用户问了你好',
          createdAt: new Date().toISOString(),
        },
      ],
      metadata: { compacted: true, compactedCount: 1 },
    });

    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0]?.content).toContain('历史对话摘要');
    // Metadata is merged, not replaced.
    expect(updated.metadata).toEqual({
      source: 'test',
      compacted: true,
      compactedCount: 1,
    });
    expect(updated.updatedAt >= session.updatedAt).toBe(true);
  });
});
