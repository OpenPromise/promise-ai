import { spawn } from 'node:child_process';
import type { Tool, ToolContext, ToolResult } from '@personal-ai/tools';

/**
 * system.status：服务器健康巡检（L0 只读）。
 * 检查磁盘 / 内存 / 负载 / 运行时长 / 容器健康，返回结构化摘要，
 * 供定时任务自主巡检与"看看服务器状态"类问题使用（JARVIS 主动监控第一步）。
 */

export interface StatusRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** 超时或被取消时终止了整个进程组。 */
  timedOut?: boolean;
}

export interface StatusRunner {
  (script: string, options: { timeoutMs: number; signal: AbortSignal }): Promise<StatusRunResult>;
}

/** 巡检脚本自身的超时（小于工具 timeoutMs，留出返回可读结果的余量）。 */
export const STATUS_SCRIPT_TIMEOUT_MS = 25_000;

/**
 * 交给巡检脚本的最小环境变量集合。
 * 不透传 process.env：那会把 OPENROUTER_API_KEY / DATABASE_URL / HOOK_SECRET
 * 等全部交给 `/bin/bash -lc` 及其所有子命令，脚本一旦被改动即成为密钥外泄面。
 * 巡检只需要 df/free/cat/docker，PATH + 语言/HOME 足够。
 */
export function minimalStatusEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    ...(env.LANG !== undefined ? { LANG: env.LANG } : {}),
    ...(env.TZ !== undefined ? { TZ: env.TZ } : {}),
  };
}

export function defaultStatusRunner(
  script: string,
  options: { timeoutMs: number; signal: AbortSignal },
): Promise<StatusRunResult> {
  return new Promise((resolve, reject) => {
    // detached=true：bash 自成进程组，超时/取消时对整个进程组发信号，
    // 保证 docker ps 等子命令不会成为孤儿继续跑（同 server-shell.ts 的 kill-tree）。
    const child = spawn('/bin/bash', ['-lc', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: minimalStatusEnv(),
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const killTree = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          child.kill(signal);
        } else {
          // 负 PID = 整个进程组（Linux/容器）
          process.kill(-child.pid, signal);
        }
      } catch {
        child.kill(signal);
      }
    };
    const onAbort = (): void => {
      killTree('SIGTERM');
      // 2 秒宽限后强杀，避免个别进程不响应 SIGTERM
      const killer = setTimeout(() => killTree('SIGKILL'), 2000);
      killer.unref?.();
    };
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    const timer = setTimeout(onAbort, options.timeoutMs);
    timer.unref?.();
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      const timedOut = signal === 'SIGTERM' || signal === 'SIGKILL';
      resolve({ stdout, stderr, exitCode: timedOut ? 124 : (code ?? 1), timedOut });
    });
  });
}

const STATUS_SCRIPT = [
  'echo DISK_START',
  "df -h / | tail -1",
  'echo DISK_END',
  'echo MEM_START',
  "free -m | grep -E 'Mem|Swap'",
  'echo MEM_END',
  'echo LOAD_START',
  'cat /proc/loadavg',
  'echo LOAD_END',
  'echo UPTIME_START',
  'cat /proc/uptime',
  'echo UPTIME_END',
  'echo DOCKER_START',
  "docker ps --format '{{.Names}}|{{.Status}}' 2>/dev/null || echo docker-unavailable",
  'echo DOCKER_END',
].join('\n');

function section(output: string, start: string, end: string): string {
  const match = output.match(new RegExp(`${start}\\n([\\s\\S]*?)\\n${end}`));
  return match?.[1]?.trim() ?? '';
}

export interface SystemStatus {
  healthy: boolean;
  issues: string[];
  disk: { usedPct: number; used: string; total: string };
  memory: { usedPct: number; usedMB: number; totalMB: number };
  load: { one: number; five: number; fifteen: number };
  uptimeSeconds: number;
  containers: Array<{ name: string; status: string; unhealthy: boolean }>;
  summary: string;
}

export function parseSystemStatus(output: string): SystemStatus {
  const issues: string[] = [];

  const diskLine = section(output, 'DISK_START', 'DISK_END').split(/\s+/);
  const disk = {
    usedPct: parseInt(diskLine[4] ?? '0', 10) || 0,
    used: diskLine[2] ?? '?',
    total: diskLine[1] ?? '?',
  };
  if (disk.usedPct > 90) issues.push(`磁盘使用率 ${disk.usedPct}% 偏高`);

  const memLines = section(output, 'MEM_START', 'MEM_END').split('\n');
  const memMatch = memLines
    .find((line) => /^Mem:/.test(line))
    ?.split(/\s+/)
    .filter(Boolean);
  const totalMB = parseInt(memMatch?.[1] ?? '0', 10) || 0;
  const usedMB = parseInt(memMatch?.[2] ?? '0', 10) || 0;
  const memory = {
    usedPct: totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0,
    usedMB,
    totalMB,
  };
  if (memory.usedPct > 90) issues.push(`内存使用率 ${memory.usedPct}% 偏高`);

  const loadParts = section(output, 'LOAD_START', 'LOAD_END').split(/\s+/);
  const load = {
    one: parseFloat(loadParts[0] ?? '0') || 0,
    five: parseFloat(loadParts[1] ?? '0') || 0,
    fifteen: parseFloat(loadParts[2] ?? '0') || 0,
  };

  const uptimeSeconds = parseInt(section(output, 'UPTIME_START', 'UPTIME_END').split(/\s+/)[0] ?? '0', 10) || 0;

  const containers = section(output, 'DOCKER_START', 'DOCKER_END')
    .split('\n')
    .filter((line) => line.includes('|'))
    .map((line) => {
      const [name, ...rest] = line.split('|');
      const status = rest.join('|').trim();
      const unhealthy = /unhealthy|restarting|exited/i.test(status);
      if (unhealthy) issues.push(`容器 ${name} 状态异常：${status}`);
      return { name: (name ?? '').trim(), status, unhealthy };
    });
  if (containers.length === 0 && !output.includes('docker-unavailable')) {
    issues.push('未检测到运行中的容器');
  }

  const healthy = issues.length === 0;
  const uptimeText =
    uptimeSeconds >= 3600
      ? `${Math.floor(uptimeSeconds / 3600)}小时${Math.floor((uptimeSeconds % 3600) / 60)}分`
      : `${Math.floor(uptimeSeconds / 60)}分`;
  const summary =
    `磁盘 ${disk.used}/${disk.total}（${disk.usedPct}%） | ` +
    `内存 ${usedMB}/${totalMB}MB（${memory.usedPct}%） | ` +
    `负载 ${load.one}/${load.five}/${load.fifteen} | ` +
    `已运行 ${uptimeText} | 容器 ${containers.length} 个` +
    (issues.length > 0 ? ` | ⚠ ${issues.join('；')}` : ' | ✅ 全部正常');

  return { healthy, issues, disk, memory, load, uptimeSeconds, containers, summary };
}

export interface SystemStatusToolOptions {
  /** 测试注入；缺省走 /bin/bash。 */
  runner?: StatusRunner;
}

export function createSystemStatusTool(options: SystemStatusToolOptions = {}): Tool {
  const runner = options.runner ?? defaultStatusRunner;
  return {
    name: 'system.status',
    description:
      '检查云服务器当前健康状态（只读 L0）：磁盘/内存/负载/运行时长/所有容器状态，' +
      '返回结构化摘要与异常列表。用于定时巡检和"看看服务器状态"类问题。',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    permissionLevel: 0,
    timeoutMs: 30_000,
    async execute(_input: unknown, context: ToolContext): Promise<ToolResult> {
      // 上层 runToolWithTimeout 的 signal 必须传下去：不消费 signal 的话
      // "超时/取消"只是上层放弃等待，bash 进程仍在跑（P1-5）。
      const controller = new AbortController();
      const onParentAbort = (): void => controller.abort();
      if (context.signal?.aborted) onParentAbort();
      else context.signal?.addEventListener('abort', onParentAbort, { once: true });
      try {
        const { stdout, stderr, timedOut } = await runner(STATUS_SCRIPT, {
          timeoutMs: STATUS_SCRIPT_TIMEOUT_MS,
          signal: controller.signal,
        });
        if (timedOut && !stdout.trim()) {
          return {
            ok: false,
            error: `system.status 巡检超过 ${Math.round(STATUS_SCRIPT_TIMEOUT_MS / 1000)} 秒未完成，已终止进程树`,
          };
        }
        const status = parseSystemStatus(stdout || stderr);
        return { ok: true, data: status };
      } catch (error) {
        return {
          ok: false,
          error: `system.status 执行失败：${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        context.signal?.removeEventListener('abort', onParentAbort);
        // 无论如何都终止子进程组（正常结束时 close 已清理，abort 幂等）。
        controller.abort();
      }
    },
  };
}
