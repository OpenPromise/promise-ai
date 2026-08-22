import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryTimelineStore } from '@personal-ai/memory';
import {
  appendCapped,
  EngineerTaskRunner,
  lastMeaningfulLine,
  type EngineerTaskEvent,
  type RunTaskFn,
} from './engineer-task-runner.js';

describe('lastMeaningfulLine / appendCapped', () => {
  it('提取最后一行有意义的输出，忽略空行与纯分隔线', () => {
    expect(lastMeaningfulLine('第一行\n---\n\n  第二行  \n')).toBe('第二行');
    expect(lastMeaningfulLine('  ')).toBeUndefined();
  });

  it('appendCapped 保留尾部并截断', () => {
    const capped = appendCapped('abc', 'def', 5);
    expect(capped).toBe('bcdef');
  });
});

function makeRunner(options: { runTask: RunTaskFn; progressIntervalMs?: number; persistDir?: string; timeline?: InMemoryTimelineStore; maxConcurrent?: number }) {
  return new EngineerTaskRunner({
    runTask: options.runTask,
    progressIntervalMs: options.progressIntervalMs ?? 0,
    persistDir: options.persistDir,
    timeline: options.timeline,
    maxConcurrent: options.maxConcurrent,
  });
}

describe('EngineerTaskRunner 异步派单', () => {
  it('delegate 立即返回 running 任务，不等 dsh 跑完（不阻塞对话）', async () => {
    let resolveRun: (() => void) | undefined;
    const runner = makeRunner({
      runTask: () =>
        new Promise((resolve) => {
          resolveRun = () =>
            resolve({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 });
        }),
    });

    const task = await runner.delegate('写一个 md5 工具', { directory: '/app' });
    expect(task.status).toBe('running');
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(runner.get(task.id)?.status).toBe('running');
    expect(resolveRun).toBeDefined();
    resolveRun!();
    // 等后台协程收尾
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.get(task.id)?.status).toBe('success');
  });

  it('dsh 输出流式转进度事件，完成发 done + 写时间线', async () => {
    const timeline = new InMemoryTimelineStore();
    const events: EngineerTaskEvent[] = [];
    const runner = makeRunner({
      timeline,
      runTask: async (_taskText, { onData }) => {
        onData?.('第一行输出\n', 'stdout');
        onData?.('第二步：正在写代码\n', 'stdout');
        return { stdout: '第二步：正在写代码\n【验证结果】全部通过', stderr: '', timedOut: false, exitCode: 0 };
      },
    });
    runner.onEvent((event) => events.push(event));

    const task = await runner.delegate('分析 grokbuild 项目');
    // 等后台协程完成
    await new Promise((r) => setTimeout(r, 10));

    expect(runner.get(task.id)?.status).toBe('success');
    expect(runner.get(task.id)?.result).toContain('全部通过');
    expect(events.map((e) => e.type)).toEqual(['started', 'progress', 'progress', 'done']);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'success', taskId: task.id });
    const timelineEvents = await timeline.listEvents();
    expect(timelineEvents.some((e) => e.summary.includes('小黑任务完成'))).toBe(true);
  });

  it('非零退出码 → failed；超时（timedOut）→ timeout', async () => {
    const runner = makeRunner({
      runTask: async () => ({ stdout: '', stderr: '编译失败', timedOut: false, exitCode: 1 }),
    });
    const failed = await runner.delegate('改坏代码');
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.get(failed.id)?.status).toBe('failed');
    expect(runner.get(failed.id)?.error).toContain('编译失败');

    const timeoutRunner = makeRunner({
      runTask: async () => ({ stdout: '', stderr: '', timedOut: true, exitCode: 124 }),
    });
    const timedOut = await timeoutRunner.delegate('跑太久');
    await new Promise((r) => setTimeout(r, 10));
    expect(timeoutRunner.get(timedOut.id)?.status).toBe('timeout');
    expect(timeoutRunner.get(timedOut.id)?.error).toContain('被终止');
  });

  it('任务记录持久化：重启后可恢复已完成任务（running 不恢复）', async () => {
    const persistDir = await mkdtemp(path.join(tmpdir(), 'engineer-tasks-'));
    try {
      const runner = makeRunner({
        persistDir,
        runTask: async () => ({ stdout: '完成报告', stderr: '', timedOut: false, exitCode: 0 }),
      });
      const done = await runner.delegate('持久化测试任务');
      await new Promise((r) => setTimeout(r, 20));

      const restarted = makeRunner({
        persistDir,
        runTask: async () => {
          throw new Error('不应该再执行');
        },
      });
      await restarted.loadPersisted();
      const restored = restarted.get(done.id);
      expect(restored?.status).toBe('success');
      expect(restored?.result).toContain('完成报告');
      expect(restarted.list(10).length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(persistDir, { recursive: true, force: true });
    }
  });

  it('输出超过上限时置 truncated 标志（grok-build 思路）', async () => {
    const smallRunner = new EngineerTaskRunner({
      runTask: async (_taskText, { onData }) => {
        onData?.('x'.repeat(100), 'stdout');
        return { stdout: 'x'.repeat(100), stderr: '', timedOut: false, exitCode: 0 };
      },
      outputCap: 50,
      progressIntervalMs: 0,
    });
    const task = await smallRunner.delegate('大输出');
    await new Promise((r) => setTimeout(r, 10));
    expect(smallRunner.get(task.id)?.truncated).toBe(true);
    expect(smallRunner.get(task.id)?.output.length).toBe(50);
  });
});

describe('EngineerTaskRunner 崩溃恢复与并发上限', () => {
  it('loadPersisted 把残留 running 标记 failed 并返回中断列表，emitTaskDone 补发事件', async () => {
    const persistDir = await mkdtemp(path.join(tmpdir(), 'engineer-tasks-'));
    try {
      const events: EngineerTaskEvent[] = [];
      const runner = makeRunner({
        persistDir,
        // 永不 resolve：让任务保持 running，才能持久化"中断前"的状态
        runTask: () => new Promise(() => {}),
      });
      const running = await runner.delegate('中断的任务');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runner.get(running.id)?.status).toBe('running');

      const restarted = makeRunner({
        persistDir,
        runTask: async () => {
          throw new Error('不应该再执行');
        },
      });
      restarted.onEvent((event) => events.push(event));
      const interrupted = await restarted.loadPersisted();

      const restored = restarted.get(running.id);
      expect(restored?.status).toBe('failed');
      expect(restored?.error).toBe('进程重启，任务中断');
      expect(interrupted.map((t) => t.id)).toEqual([running.id]);
      // 事件通道就绪前不 emit（启动早期补发会发进虚空）
      expect(events).toHaveLength(0);
      // 通道就绪后由调用方补发
      restarted.emitTaskDone(running.id);
      expect(events.filter((event) => event.type === 'done')).toEqual([
        expect.objectContaining({
          type: 'done',
          taskId: running.id,
          status: 'failed',
          error: '进程重启，任务中断',
        }),
      ]);
    } finally {
      await rm(persistDir, { recursive: true, force: true });
    }
  });

  it('maxConcurrent 超限任务排队，前一个完成后自动出队', async () => {
    let active = 0;
    let maxActive = 0;
    const pending: Array<() => void> = [];
    const runner = makeRunner({
      maxConcurrent: 2,
      runTask: () =>
        new Promise((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          pending.push(() => {
            active -= 1;
            resolve({ stdout: 'ok', stderr: '', timedOut: false, exitCode: 0 });
          });
        }),
    });

    const first = await runner.delegate('任务 1');
    const second = await runner.delegate('任务 2');
    const third = await runner.delegate('任务 3');
    await new Promise((r) => setTimeout(r, 10));
    expect(maxActive).toBe(2);
    expect(pending).toHaveLength(2);
    // 三个任务都还处于 running 状态（第三个在队列里等待开工）
    expect(runner.get(first.id)?.status).toBe('running');
    expect(runner.get(second.id)?.status).toBe('running');
    expect(runner.get(third.id)?.status).toBe('running');

    // 放行第一个（FIFO），第三个应自动出队并开始执行
    pending[0]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(maxActive).toBe(2);
    expect(pending).toHaveLength(3);
    expect(runner.get(first.id)?.status).toBe('success');

    // 依次放行剩余任务
    pending[1]!();
    await new Promise((r) => setTimeout(r, 10));
    pending[2]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.get(second.id)?.status).toBe('success');
    expect(runner.get(third.id)?.status).toBe('success');
    expect(active).toBe(0);
  });
});

/**
 * N4-P2-3：#persist 早前直接 writeFile 最终文件、且无写序列化。
 *
 * 注意这两个用例是回归护栏，不是能复现旧 bug 的红检：实测下来旧实现在
 * Node/NTFS 上很难从公开 API 观测到截断（并发 writeFile 会收敛到"最后一次写
 * 完整落盘"，连并发读者也抓不到半成品）。真正的风险窗口是**进程在 write 中途
 * 被杀**，那需要 kill -9 级别的注入才能稳定复现，不适合放进单测。
 * 因此这里锁住修复后可断言的性质：落盘内容完整、快照是最新的、rename 后
 * 不留 .tmp、以及写失败不致命。
 */
describe('EngineerTaskRunner 持久化原子性与写序列化（N4-P2-3）', () => {
  it('多任务同时完成时任务表是完整 JSON 且为最新快照，不残留 .tmp', async () => {
    const persistDir = await mkdtemp(path.join(tmpdir(), 'engineer-tasks-'));
    const file = path.join(persistDir, 'engineer-tasks.json');
    try {
      const release: Array<() => void> = [];
      const runner = makeRunner({
        persistDir,
        maxConcurrent: 12,
        // 输出足够长，让每次序列化的字节数差异明显（截断才可观测）
        runTask: () =>
          new Promise((resolve) => {
            release.push(() =>
              resolve({ stdout: 'R'.repeat(4000), stderr: '', timedOut: false, exitCode: 0 }),
            );
          }),
      });

      const tasks = [];
      for (let i = 0; i < 12; i += 1) {
        tasks.push(await runner.delegate(`并发任务 ${i}`.repeat(30)));
      }
      await new Promise((r) => setTimeout(r, 20));

      // 同一 tick 内全部 finish → 12 次 #persist 并发进入写队列
      for (const done of release) done();
      await new Promise((r) => setTimeout(r, 80));

      // 落盘内容完整可解析
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Array<{ id: string }>;
      expect(parsed).toHaveLength(12);
      // 关键性质：快照在写队列串行化后仍是最新的（每次写入在队列内重新读
      // 任务表，而不是入队时的旧快照），12 个任务都已 success。
      expect(parsed.every((record) => (record as { status?: string }).status === 'success')).toBe(
        true,
      );
      const restarted = makeRunner({
        persistDir,
        runTask: async () => {
          throw new Error('不应该再执行');
        },
      });
      const interrupted = await restarted.loadPersisted();
      expect(interrupted).toHaveLength(0);
      for (const task of tasks) {
        expect(restarted.get(task.id)?.status).toBe('success');
      }

      // rename 之后不该留下 .tmp 中间文件
      const leftovers = await readdir(persistDir);
      expect(leftovers).toEqual(['engineer-tasks.json']);
    } finally {
      await rm(persistDir, { recursive: true, force: true });
    }
  });

  it('写入失败（持久化目录被占为普通文件）不致命，任务仍可查询', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'engineer-tasks-'));
    // 用一个普通文件占住 persistDir，mkdir/writeFile 必失败
    const persistDir = path.join(base, 'blocked');
    await writeFile(persistDir, 'not a directory', 'utf8');
    try {
      const runner = makeRunner({
        persistDir,
        runTask: async () => ({ stdout: '完成', stderr: '', timedOut: false, exitCode: 0 }),
      });
      const task = await runner.delegate('持久化会失败的任务');
      await new Promise((r) => setTimeout(r, 20));
      // 持久化失败被吞掉，但内存态仍然正确（不影响运行/查询）
      expect(runner.get(task.id)?.status).toBe('success');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
