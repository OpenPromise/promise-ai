import { describe, expect, it } from 'vitest';
import { InMemorySessionStore, type SessionStore } from '@personal-ai/memory';
import type { ChatMessage } from '@personal-ai/types';
import {
  countDanglingToolCalls,
  recoverInterruptedSessions,
  RESTART_RECOVERY_MARKER,
} from './restart-recovery.js';

function message(
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: `${role}-${content}-${Math.random()}`,
    sessionId: 's1',
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

describe('countDanglingToolCalls', () => {
  it('counts assistant tool calls without a matching tool result', () => {
    const messages = [
      message('assistant', '', {
        toolCalls: [
          { id: 'call_1', name: 'files.read', arguments: '{}' },
          { id: 'call_2', name: 'files.list', arguments: '{}' },
        ],
      }),
      message('tool', 'ok', { toolCallId: 'call_1' }),
    ];
    expect(countDanglingToolCalls(messages)).toBe(1);
  });

  it('returns zero when every tool call has a result', () => {
    const messages = [
      message('assistant', '', {
        toolCalls: [{ id: 'call_1', name: 'files.read', arguments: '{}' }],
      }),
      message('tool', 'ok', { toolCallId: 'call_1' }),
    ];
    expect(countDanglingToolCalls(messages)).toBe(0);
  });
});

describe('recoverInterruptedSessions', () => {
  async function seedStore(): Promise<SessionStore> {
    const store = new InMemorySessionStore();
    const interrupted = await store.createSession();
    await store.addMessage(interrupted.id, {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'files.read', arguments: '{}' }],
    });
    const healthy = await store.createSession();
    await store.addMessage(healthy.id, { role: 'user', content: '你好' });
    return store;
  }

  it('injects a recovery note into interrupted sessions only', async () => {
    const store = await seedStore();
    const result = await recoverInterruptedSessions(store);

    expect(result.recovered).toBe(1);
    const sessions = await store.listSessions();
    const noted = sessions.filter((session) =>
      session.messages.some(
        (m) => m.role === 'system' && m.content.includes(RESTART_RECOVERY_MARKER),
      ),
    );
    expect(noted).toHaveLength(1);
  });

  it('is idempotent across restarts', async () => {
    const store = await seedStore();
    await recoverInterruptedSessions(store);
    const second = await recoverInterruptedSessions(store);
    expect(second.recovered).toBe(0);
  });

  it('ignores sessions updated before the recency window', async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession();
    await store.addMessage(session.id, {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'files.read', arguments: '{}' }],
    });
    const result = await recoverInterruptedSessions(store, {
      recentMinutes: 60,
      now: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    expect(result.recovered).toBe(0);
  });
});
