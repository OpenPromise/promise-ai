import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '@personal-ai/memory';
import { ColleagueTaskRunner, type ColleagueSpec, type ColleagueTaskEvent } from './colleague-task-runner.js';
import {
  COLLEAGUE_IDS,
  ColleagueOffice,
  type ColleagueConversation,
  type ColleagueId,
  type ColleagueRunners,
} from './colleague-office.js';
import { colleagueForkEnabled } from './colleague-fork.js';

function stubSpec(id: string, name: string): ColleagueSpec {
  return {
    id,
    name,
    permissionMode: 'workspace-write',
    buildTask: (task) => task,
    startedText: `${name}已开工`,
  };
}

function stubRunners(): ColleagueRunners {
  const names: Record<ColleagueId, string> = {
    xiaohei: '小黑',
    xiaoyou: '小优',
    xiaomei: '小美',
    xiaozhen: '小真',
    xiaozhi: '小知',
  };
  const runners = {} as ColleagueRunners;
  for (const id of COLLEAGUE_IDS) {
    runners[id] = new ColleagueTaskRunner(stubSpec(id, names[id]), {
      runTask: async () => ({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 }),
    });
  }
  return runners;
}

function fakeChild(): ChildProcess {
  const emitter = new EventEmitter();
  const child = emitter as unknown as ChildProcess;
  Object.assign(child, {
    pid: 4242,
    killed: false,
    exitCode: null,
    signalCode: null,
    connected: true,
    kill() {
      (child as unknown as { killed: boolean }).killed = true;
      return true;
    },
    send() {
      return false;
    },
  });
  return child;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timeout waiting for fork office condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('colleagueForkEnabled', () => {
  it('vitest 默认关 fork', () => {
    expect(colleagueForkEnabled()).toBe(false);
  });
});

describe('ColleagueOffice parent isolation', () => {
  const dirs: string[] = [];
  const offices: ColleagueOffice[] = [];

  afterEach(async () => {
    for (const office of offices.splice(0)) office.close();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('COLLEAGUE_FORK parent 不跑同事 runChat；子进程落盘 done 后父进程只跑 wrap-up', async () => {
    const mailboxDir = await mkdtemp(path.join(tmpdir(), 'mailboxes-fork-'));
    dirs.push(mailboxDir);
    const store = new InMemorySessionStore();
    const hub = await store.createSession({ systemPrompt: '小夜' });
    const calls: string[] = [];
    const conversation: ColleagueConversation = {
      async *runChat(input) {
        calls.push(input.userMessage.slice(0, 12));
        if (input.userMessage.startsWith('【同事回信】')) {
          yield { type: 'chat.done', payload: { text: '小夜：验收通过，首页改好了' } };
          return;
        }
        throw new Error('parent must not run colleague chat');
      },
    };
    const forked: ColleagueId[] = [];
    const office = new ColleagueOffice({
      store,
      runners: stubRunners(),
      mailboxDir,
      gitRepoDir: null,
      isolation: 'parent',
      forkWorker: (id) => {
        forked.push(id);
        return fakeChild();
      },
    });
    offices.push(office);
    await office.ensureSessions();
    office.attachConversation(conversation);
    await office.hydrate();
    expect(forked).toEqual([...COLLEAGUE_IDS]);

    const events: ColleagueTaskEvent[] = [];
    office.onEvent((event) => events.push(event));

    const task = await office.delegate('xiaohei', '做小真主页', { hubSessionId: hub.id });
    expect(task.status).toBe('running');
    expect(calls).toEqual([]);
    expect(events.some((event) => event.type === 'started')).toBe(true);

    const mailboxPath = path.join(mailboxDir, 'xiaohei.json');
    const items = JSON.parse(await readFile(mailboxPath, 'utf8')) as Array<Record<string, unknown>>;
    expect(items[0]?.status).toBe('queued');
    items[0] = { ...items[0], status: 'done', reply: '首页 v2 已改完' };
    await writeFile(mailboxPath, JSON.stringify(items, null, 2), 'utf8');

    await office.ingestChildEvent({
      type: 'done',
      taskId: task.id,
      status: 'success',
      colleague: '小黑',
      colleagueId: 'xiaohei',
      mailId: String(items[0]?.id ?? ''),
      result: '首页 v2 已改完',
    });

    await waitFor(() => events.some((event) => event.type === 'done'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.startsWith('【同事回信】')).toBe(true);
    const done = events.find((event) => event.type === 'done');
    expect(done?.result).toContain('验收通过');
  });
});
