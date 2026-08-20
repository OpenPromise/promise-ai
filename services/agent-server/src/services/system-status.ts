import { spawn } from 'node:child_process';
import type { Tool, ToolResult } from '@personal-ai/tools';

/**
 * system.status：服务器健康巡检（L0 只读）。
 * 检查磁盘 / 内存 / 负载 / 运行时长 / 容器健康，返回结构化摘要，
 * 供定时任务自主巡检与"看看服务器状态"类问题使用（JARVIS 主动监控第一步）。
 */

export interface StatusRunner {
  (script: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export function defaultStatusRunner(script: string): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-lc', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
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
    async execute(): Promise<ToolResult> {
      try {
        const { stdout, stderr } = await runner(STATUS_SCRIPT);
        const status = parseSystemStatus(stdout || stderr);
        return { ok: true, data: status };
      } catch (error) {
        return {
          ok: false,
          error: `system.status 执行失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
