import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

function makeRunner(options: { runTask: RunTaskFn; progressIntervalMs?: number; persistDir?: string; timeline?: InMemoryTimelineStore }) {
  return new EngineerTaskRunner({
    runTask: options.runTask,
    progressIntervalMs: options.progressIntervalMs ?? 0,
    persistDir: options.persistDir,
    timeline: options.timeline,
  });
}

describe('EngineerTaskRunner 异步派单', () => {
  it('delegate 立即返回 running 任务，不等 dsh 跑完（不阻塞对话）', async () => {
    let resolveRun: (() => void) | undefined;
    const runner = makeRunner({
      runTask: () =>
        new Promise((resolve) => {
          resolveRun = () =>
            resolve({ stdout: 'ok', stderr: '', killed: false, exitCode: 0 });
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
        return { stdout: '第二步：正在写代码\n【验证结果】全部通过', stderr: '', killed: false, exitCode: 0 };
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

  it('非零退出码 → failed；超时（124）→ timeout', async () => {
    const runner = makeRunner({
      runTask: async () => ({ stdout: '', stderr: '编译失败', killed: true, exitCode: 1 }),
    });
    const failed = await runner.delegate('改坏代码');
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.get(failed.id)?.status).toBe('failed');
    expect(runner.get(failed.id)?.error).toContain('编译失败');

    const timeoutRunner = makeRunner({
      runTask: async () => ({ stdout: '', stderr: '', killed: true, exitCode: 124 }),
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
        runTask: async () => ({ stdout: '完成报告', stderr: '', killed: false, exitCode: 0 }),
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
        return { stdout: 'x'.repeat(100), stderr: '', killed: false, exitCode: 0 };
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
