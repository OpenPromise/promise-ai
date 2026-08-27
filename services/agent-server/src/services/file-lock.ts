import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';

type LockableHandle = {
  lock?: (exclusive?: boolean) => Promise<void>;
  unlock?: () => Promise<void>;
  close: () => Promise<void>;
};

const SPIN_WAIT_MS = 40;
const SPIN_STALE_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 跨进程互斥：优先 FileHandle.lock（flock，进程死会释放）。
 * 没有 lock API 时退回 O_EXCL 自旋锁（过期 120s 视为陈旧）。
 */
export async function withExclusiveFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    await mkdir(path.dirname(lockPath), { recursive: true });
  } catch {
    return fn();
  }

  let handle: LockableHandle;
  try {
    handle = (await open(lockPath, 'a')) as LockableHandle;
  } catch {
    return fn();
  }

  const hasFlock = typeof handle.lock === 'function';
  const spinPath = `${lockPath}.spin`;
  if (hasFlock) {
    await handle.lock!(true);
  } else {
    await acquireSpinLock(spinPath);
  }

  try {
    return await fn();
  } finally {
    if (hasFlock) {
      try {
        await handle.unlock?.();
      } catch {
        // unlock 失败仍要 close，fd 关掉也会释放 flock
      }
    } else {
      await releaseSpinLock(spinPath);
    }
    try {
      await handle.close();
    } catch {
      // ignore
    }
  }
}

async function acquireSpinLock(lockPath: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx');
      try {
        await fh.writeFile(`${process.pid}\n${Date.now()}\n`);
      } finally {
        await fh.close();
      }
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'EEXIST') throw error;
      try {
        const stale = await open(lockPath, 'r');
        try {
          const raw = await stale.readFile('utf8');
          const ts = Number((raw.split('\n')[1] ?? '').trim());
          if (Number.isFinite(ts) && Date.now() - ts > SPIN_STALE_MS) {
            await unlink(lockPath).catch(() => {});
            continue;
          }
        } finally {
          await stale.close();
        }
      } catch {
        // 读失败就继续等
      }
      if (Date.now() - started > 60_000) {
        throw new Error(`file lock timeout: ${lockPath}`);
      }
      await sleep(SPIN_WAIT_MS);
    }
  }
}

async function releaseSpinLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {
    // ignore
  }
}
