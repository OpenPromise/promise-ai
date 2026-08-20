import { spawn } from 'node:child_process';
import type { PermissionLevel, Tool, ToolResult } from '@personal-ai/tools';

/**
 * server.shell：在服务器容器内执行 bash 命令（容器内终端，L3 系统级）。
 * 这是"云服务器即她的世界"的关键拼图：git clone、npm install、启动服务、
 * docker 操作等都可以直接做；默认工作目录 /projects（宿主机持久工作区）。
 *
 * 权限说明（AGENTS.md）：L3 系统级——等于在服务器上拥有完整 shell，
 * 微信通道默认自动拒绝（L2/L3），桌面/自主模式按既有权限表执行。
 */

export interface ShellOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ShellRunner = (
  command: string,
  options: { cwd: string; timeoutMs: number; signal: AbortSignal },
) => Promise<ShellOutput>;

function defaultRunner(
  command: string,
  options: { cwd: string; timeoutMs: number; signal: AbortSignal },
): Promise<ShellOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: options.cwd,
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
    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);
    timer.unref?.();
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      resolve({
        exitCode: signal === 'SIGTERM' ? 124 : (code ?? 1),
        stdout,
        stderr,
      });
    });
  });
}

export interface ServerShellToolOptions {
  /** 测试注入：自定义命令执行器；缺省走 /bin/bash。 */
  runner?: ShellRunner;
  /** 默认工作目录（缺省 /projects 持久工作区）。 */
  defaultCwd?: string;
}

export function createServerShellTool(
  options: ServerShellToolOptions = {},
): Tool {
  const runner = options.runner ?? defaultRunner;
  const defaultCwd = options.defaultCwd ?? '/projects';

  return {
    name: 'server.shell',
    description:
      '在服务器容器内执行 bash 命令（相当于容器内终端，L3 系统级）。' +
      '可做任何服务器操作：git clone / npm install / 运行服务 / docker 起容器并映射端口等。' +
      '默认工作目录 /projects（宿主机持久工作区，重启不丢）。' +
      '输出最多返回 20000 字符；长任务请拆分或加大 timeoutSeconds。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 bash 命令' },
        cwd: {
          type: 'string',
          description: '工作目录，默认 /projects（持久工作区）',
        },
        timeoutSeconds: {
          type: 'number',
          minimum: 1,
          maximum: 300,
          description: '超时上限（秒），默认 60',
        },
      },
      required: ['command'],
    },
    permissionLevel: 3 as PermissionLevel,
    timeoutMs: 5 * 60 * 1000,
    async execute(input: unknown): Promise<ToolResult> {
      const { command, cwd, timeoutSeconds = 60 } = (input ?? {}) as {
        command?: string;
        cwd?: string;
        timeoutSeconds?: number;
      };
      if (!command?.trim()) {
        return { ok: false, error: '缺少 command 参数' };
      }
      const resolvedCwd = cwd?.trim() || defaultCwd;
      const timeoutMs = Math.min(Math.max(1, Math.floor(timeoutSeconds)), 300) * 1000;
      const controller = new AbortController();
      try {
        const result = await runner(command.trim(), {
          cwd: resolvedCwd,
          timeoutMs,
          signal: controller.signal,
        });
        const timedOut = result.exitCode === 124;
        return {
          ok: true,
          data: {
            exitCode: result.exitCode,
            timedOut,
            stdout: result.stdout.slice(0, 20_000),
            stderr: result.stderr.slice(0, 10_000),
            note: timedOut ? `命令超过 ${Math.round(timeoutMs / 1000)} 秒被终止` : undefined,
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: `server.shell 执行失败：${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        controller.abort();
      }
    },
  };
}
