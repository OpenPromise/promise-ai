import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ColleagueId } from './colleague-office.js';

/** 生产默认开 fork；vitest / COLLEAGUE_FORK=0 走进程内 worker。 */
export function colleagueForkEnabled(): boolean {
  const raw = (process.env.COLLEAGUE_FORK ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
  if (process.env.VITEST) return false;
  if ((process.env.NODE_ENV ?? '').trim().toLowerCase() === 'test') return false;
  return true;
}

function tsxExecArgv(): string[] {
  if (process.execArgv.some((arg) => arg.includes('tsx'))) return process.execArgv;
  if (process.execArgv.length > 0) return process.execArgv;
  const argv1 = process.argv[1] ?? '';
  if (argv1.includes('tsx')) return ['--import', 'tsx'];
  return ['--import', 'tsx'];
}

export function colleagueWorkerPath(): string {
  return fileURLToPath(new URL('../colleague-worker.ts', import.meta.url));
}

/**
 * fork 同事信箱子进程。子进程 COLLEAGUE_FORK=0，避免孙进程。
 * 与父进程同一 node + tsx，同容器 /app、postgres、docker.sock。
 */
export function forkColleagueWorker(colleagueId: ColleagueId): ChildProcess {
  const workerPath = colleagueWorkerPath();
  const execArgv = tsxExecArgv();
  return fork(workerPath, [], {
    execPath: process.execPath,
    execArgv,
    env: {
      ...process.env,
      COLLEAGUE_ID: colleagueId,
      COLLEAGUE_FORK: '0',
      AGENT_INTERNAL_URL: process.env.AGENT_INTERNAL_URL ?? 'http://127.0.0.1:3000',
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
}
