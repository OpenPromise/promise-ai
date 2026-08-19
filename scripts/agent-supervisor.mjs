// Agent Server 守护进程：子进程退出后自动拉起。
// 自我更新（system.restart）依赖它：服务优雅退出后由这里重新启动。
// 容器部署则靠 Docker 的 restart 策略（除非手动 stop，否则容器退出自动重启）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESTART_DELAY_MS = 1500;
const MAX_BACKOFF_MS = 30_000;

let child = null;
let shuttingDown = false;
let fastRestarts = 0;

function start() {
  const startedAt = Date.now();
  console.log('[supervisor] starting agent-server');
  // 直接用 node + tsx 启动，避免经 npm/shell 的转义与弃用警告
  child = spawn(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(ROOT, 'services', 'agent-server', 'src', 'index.ts'),
    ],
    {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  child.on('error', (error) => {
    console.error('[supervisor] failed to spawn agent-server:', error);
    setTimeout(start, RESTART_DELAY_MS);
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (shuttingDown) return;
    const uptime = Date.now() - startedAt;
    // 启动不到 5 秒就退出 = 大概率崩溃，退避防重启风暴
    fastRestarts = uptime < 5000 ? fastRestarts + 1 : 0;
    const delay = Math.min(RESTART_DELAY_MS * 2 ** Math.min(fastRestarts, 5), MAX_BACKOFF_MS);
    console.log(
      `[supervisor] agent-server exited (code=${code}, signal=${signal}); restart in ${delay}ms`,
    );
    setTimeout(start, delay);
  });
}

function shutdown(signal) {
  shuttingDown = true;
  console.log(`[supervisor] ${signal}, stopping agent-server`);
  if (child) child.kill(signal);
  setTimeout(() => process.exit(0), 800);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
