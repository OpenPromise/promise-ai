import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySessionStore, InMemoryTaskStore } from '@personal-ai/memory';
import type { ConversationService } from './conversation.js';
import type { ColleagueOffice, MailItem } from './colleague-office.js';
import {
  collectHeartbeatSignals,
  ensureDigestTasks,
  HeartbeatService,
  isSilentHeartbeatOutput,
  DIGEST_TASK_NAMES,
  MORNING_DIGEST_ACTION,
} from './heartbeat-service.js';

function emptyMailboxes(): Record<string, MailItem[]> {
  return {
    xiaohei: [],
    xiaoyou: [],
    xiaomei: [],
    xiaozhen: [],
    xiaozhi: [],
  };
}

describe('collectHeartbeatSignals', () => {
  it('reports clean when nothing pending', () => {
    const signals = collectHeartbeatSignals({
      mailboxes: emptyMailboxes() as never,
      now: new Date('2026-09-11T12:00:00.000Z'),
    });
    expect(signals.needsAttention).toBe(false);
    expect(signals.summary).toContain('未见异常');
  });

  it('flags stale running mail and recent failures', () => {
    const now = new Date('2026-09-11T12:00:00.000Z');
    const mailboxes = emptyMailboxes();
    mailboxes.xiaohei = [
      {
        id: 'm1',
        from: 'xiaoye',
        to: 'xiaohei',
        body: '修登录页',
        createdAt: '2026-09-11T10:00:00.000Z', // 120m ago
        status: 'running',
      },
      {
        id: 'm2',
        from: 'xiaoye',
        to: 'xiaohei',
        body: '失败单',
        createdAt: '2026-09-11T11:30:00.000Z',
        status: 'failed',
      },
    ];
    const signals = collectHeartbeatSignals({
      mailboxes: mailboxes as never,
      recentTaskErrors: [{ name: 'backup', error: 'disk full', finishedAt: now.toISOString() }],
      now,
    });
    expect(signals.needsAttention).toBe(true);
    expect(signals.summary).toContain('小黑');
    expect(signals.summary).toContain('backup');
  });
});

describe('isSilentHeartbeatOutput', () => {
  it('treats HEARTBEAT_OK and NO_REPLY as silent', () => {
    expect(isSilentHeartbeatOutput('HEARTBEAT_OK')).toBe(true);
    expect(isSilentHeartbeatOutput('NO_REPLY')).toBe(true);
    expect(isSilentHeartbeatOutput('  heartbeat_ok  ')).toBe(true);
    expect(isSilentHeartbeatOutput('小黑卡住了')).toBe(false);
  });
});

describe('ensureDigestTasks', () => {
  it('creates morning/evening tasks once', async () => {
    const tasks = new InMemoryTaskStore();
    const createTaskSession = vi.fn(async () => 'sess-1');
    const first = await ensureDigestTasks({ tasks, createTaskSession });
    expect(first.created.sort()).toEqual([
      DIGEST_TASK_NAMES.evening,
      DIGEST_TASK_NAMES.morning,
    ]);
    expect(createTaskSession).toHaveBeenCalledTimes(2);
    const listed = await tasks.listTasks();
    expect(listed.map((t) => t.name).sort()).toEqual([
      DIGEST_TASK_NAMES.evening,
      DIGEST_TASK_NAMES.morning,
    ]);
    expect(listed.find((t) => t.name === DIGEST_TASK_NAMES.morning)?.schedule).toBe('0 9 * * *');
    expect(listed.find((t) => t.name === DIGEST_TASK_NAMES.morning)?.action).toBe(
      MORNING_DIGEST_ACTION,
    );

    const second = await ensureDigestTasks({ tasks, createTaskSession });
    expect(second.created).toEqual([]);
    expect(second.skipped.sort()).toEqual([
      DIGEST_TASK_NAMES.evening,
      DIGEST_TASK_NAMES.morning,
    ]);
    expect(createTaskSession).toHaveBeenCalledTimes(2);
  });
});

describe('HeartbeatService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits HEARTBEAT_OK without LLM when signals are clean', async () => {
    const sessions = new InMemorySessionStore();
    const tasks = new InMemoryTaskStore();
    const runChat = vi.fn(async function* () {
      yield {
        type: 'chat.done',
        timestamp: new Date().toISOString(),
        sessionId: 'x',
        requestId: 'r',
        payload: { text: 'should not run' },
      };
    });
    const office = {
      listMailbox: () => [],
    } as unknown as ColleagueOffice;
    const events: Array<{ output?: string; status: string }> = [];
    const service = new HeartbeatService({
      conversation: { runChat } as unknown as ConversationService,
      sessions,
      tasks,
      colleagueOffice: office,
      systemPrompt: async () => 'sys',
      heartbeatPrompt: async () => 'hb',
      enabled: true,
      everyMs: 60_000,
    });
    service.onRun((event) => events.push(event));
    await service.checkNow();
    service.stop();
    expect(runChat).not.toHaveBeenCalled();
    expect(events[0]?.status).toBe('success');
    expect(events[0]?.output).toBe('HEARTBEAT_OK');
  });

  it('skips when busy-guard is true', async () => {
    const sessions = new InMemorySessionStore();
    const tasks = new InMemoryTaskStore();
    const runChat = vi.fn(async function* () {});
    const office = {
      listMailbox: () => [
        {
          id: 'm1',
          from: 'xiaoye',
          to: 'xiaohei',
          body: 'stuck',
          createdAt: '2026-01-01T00:00:00.000Z',
          status: 'running',
        },
      ],
    } as unknown as ColleagueOffice;
    const events: unknown[] = [];
    const service = new HeartbeatService({
      conversation: { runChat } as unknown as ConversationService,
      sessions,
      tasks,
      colleagueOffice: office,
      systemPrompt: async () => 'sys',
      isBusy: () => true,
      now: () => new Date('2026-09-11T12:00:00.000Z'),
    });
    service.onRun((event) => events.push(event));
    await service.checkNow();
    service.stop();
    expect(runChat).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('runs headless turn when attention needed and pushes digest', async () => {
    const sessions = new InMemorySessionStore();
    const tasks = new InMemoryTaskStore();
    const runChat = vi.fn(async function* (input: { headless?: boolean; toolBudget?: number }) {
      expect(input.headless).toBe(true);
      expect(input.toolBudget).toBe(5);
      yield {
        type: 'chat.done',
        timestamp: new Date().toISOString(),
        sessionId: 'x',
        requestId: 'r',
        payload: { text: '小黑有一封卡住的任务，建议看看。' },
      };
    });
    const office = {
      listMailbox: (id: string) =>
        id === 'xiaohei'
          ? [
              {
                id: 'm1',
                from: 'xiaoye',
                to: 'xiaohei',
                body: '卡住的活',
                createdAt: '2026-09-11T10:00:00.000Z',
                status: 'running',
              },
            ]
          : [],
    } as unknown as ColleagueOffice;
    const events: Array<{ output?: string }> = [];
    const service = new HeartbeatService({
      conversation: { runChat } as unknown as ConversationService,
      sessions,
      tasks,
      colleagueOffice: office,
      systemPrompt: async () => 'sys',
      heartbeatPrompt: async () => 'hb rules',
      now: () => new Date('2026-09-11T12:00:00.000Z'),
    });
    service.onRun((event) => events.push(event));
    await service.checkNow();
    service.stop();
    expect(runChat).toHaveBeenCalledOnce();
    expect(events[0]?.output).toContain('小黑');
  });
});
