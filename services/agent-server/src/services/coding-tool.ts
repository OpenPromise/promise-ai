import { access } from 'node:fs/promises';
import { accessSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { PermissionLevel, Tool, ToolResult } from '@personal-ai/tools';

/**
 * coding.run 服务端实现：在服务器（容器）上直接驱动本机 AI 编程代理。
 * 默认后端 dsh（DeepSeek Harness，插件化）；CODING_AGENT=claude 可切 Claude Code。
 * 桌面端工具列表不再包含 coding.run——它属于"大脑"而不是"客户端外壳"。
 */

interface CodingInput {
  directory?: string;
  task?: string;
  permissionMode?: string;
  timeoutMinutes?: number;
}

/** 本机 Claude Code 可执行文件（原生 exe；Linux 上通常不存在）。 */
function resolveClaudeExecutable(): string | null {
  const candidates = [
    process.env.CLAUDE_CODE_CLI,
    path.join(
      process.env.APPDATA ?? '',
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** 本机 dsh（DeepSeek Harness）的 bin.js 绝对路径；用 node 直连，避免 shim 引号问题。 */
function resolveDshBin(): string | null {
  const npmGlobalCandidates =
    process.platform === 'win32'
      ? [path.join(process.env.APPDATA ?? '', 'npm', 'node_modules')]
      : [
          path.join(process.env.NPM_CONFIG_PREFIX ?? '/usr/local', 'lib', 'node_modules'),
          '/usr/local/lib/node_modules',
          '/usr/lib/node_modules',
        ];
  const candidates = [
    process.env.DSH_CLI,
    ...npmGlobalCandidates.map((root) =>
      path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * coding.run 后端：dsh（默认，DeepSeek Harness，插件化可扩展）或 claude（Claude Code，
 * 同一目录会话可续接）。通过环境变量 CODING_AGENT=claude 切回。
 */
const CODING_AGENT: 'dsh' | 'claude' =
  (process.env.CODING_AGENT ?? '').toLowerCase() === 'claude' ? 'claude' : 'dsh';

/**
 * Claude Code 会话复用：key 为规范化目录，value 为 Claude 的 session_id。
 * 进程内保存，agent-server 重启后丢失（后续可持久化到磁盘/Postgres）。
 */
const codingSessions = new Map<string, string>();

interface ChildOutput {
  stdout: string;
  stderr: string;
  killed: boolean;
  exitCode: number;
}

function runChild(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; stdin?: string },
): Promise<ChildOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => reject(error));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, options.timeoutMs);
    timer.unref?.();
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const timedOut = signal === 'SIGTERM';
      resolve({
        stdout,
        stderr,
        killed: timedOut || code !== 0,
        exitCode: timedOut ? 124 : (code ?? 1),
      });
    });
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

async function runClaudeCode(
  args: string[],
  options: { cwd: string; task: string; timeoutMs: number },
): Promise<ChildOutput> {
  const claude = resolveClaudeExecutable();
  if (!claude) {
    return {
      stdout: '',
      stderr: '未找到 Claude Code 可执行文件（服务器上请使用默认的 dsh 后端）',
      killed: true,
      exitCode: 1,
    };
  }
  return runChild(claude, args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    stdin: options.task,
  });
}

async function runDshHeadless(
  task: string,
  options: {
    cwd: string;
    timeoutMs: number;
    permissionMode: 'workspace-write' | 'danger-full-access';
  },
): Promise<ChildOutput> {
  const dshBin = resolveDshBin();
  if (!dshBin) {
    return {
      stdout: '',
      stderr: '未找到 dsh，请确认容器/服务器已安装 @deepseek-ai/dsh',
      killed: true,
      exitCode: 1,
    };
  }
  return runChild(process.execPath, [dshBin, '--profile', 'headless', task], {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: { ...process.env, DSH_PERMISSION_MODE: options.permissionMode },
  });
}

export function createCodingTool(): Tool {
  return {
    name: 'coding.run',
    description:
      '把开发任务交给服务器上的 AI 编程代理执行（读/写代码、跑测试、修 bug 等）。' +
      '默认后端是 dsh（DeepSeek Harness，插件化可扩展）；设环境变量 CODING_AGENT=claude 可切回 Claude Code。' +
      'dsh 模式每次调用是全新会话（headless 无续接）；claude 模式同一目录的后续任务会自动延续会话。' +
      '耗时较长（通常 30 秒到数分钟），建议在文字聊天中使用；语音会话可走 voice.delegate。' +
      'dsh 模式下 acceptEdits=工作区内写入，bypassPermissions=完全免沙箱。' +
      'directory 是服务器文件系统路径：持久工作目录用 /app（bind mount，重启不丢）；' +
      '不要在 /tmp 下放重要文件（容器重启会清空）。' +
      '完成开发后必须调用 self.commit 提交并推送 git，否则部署脚本会清理未提交的改动。' +
      '仅用于需要读写代码、修改文件或复杂工程调查的任务；' +
      '如果只是查文件是否存在、看目录内容、读文件、查状态这类轻量问题，' +
      '优先用 filesystem.search / filesystem.read / terminal.run 等轻量工具，不要启动 coding.run。',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description:
            '项目目录绝对路径（服务器文件系统），用 /app 等持久目录（bind mount）；' +
            '避免 /tmp（容器重启清空）',
        },
        task: {
          type: 'string',
          description: '要完成的任务描述，越具体越好',
        },
        permissionMode: {
          type: 'string',
          enum: ['acceptEdits', 'bypassPermissions'],
          description: 'acceptEdits=允许修改文件和执行命令（默认）；bypassPermissions=完全免确认',
        },
        timeoutMinutes: {
          type: 'number',
          minimum: 1,
          maximum: 60,
          description: '等待上限（分钟），默认 10',
        },
      },
      required: ['directory', 'task'],
    },
    permissionLevel: 1 as PermissionLevel,
    timeoutMs: 60 * 60 * 1000,
    async execute(input: unknown): Promise<ToolResult> {
      const {
        directory,
        task,
        permissionMode = 'acceptEdits',
        timeoutMinutes = 10,
      } = (input ?? {}) as CodingInput;
      if (!directory?.trim() || !task?.trim()) {
        return { ok: false, error: '缺少 directory 或 task 参数' };
      }
      const resolvedDir = path.resolve(directory.trim());
      try {
        await access(resolvedDir);
      } catch {
        return { ok: false, error: `目录不存在：${resolvedDir}` };
      }
      const mode = permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits';
      const timeoutMs = Math.min(Math.max(1, Math.floor(timeoutMinutes)), 60) * 60 * 1000;

      if (CODING_AGENT === 'dsh') {
        const taskText = task.trim();
        if (taskText.length > 20_000) {
          return {
            ok: false,
            error:
              '任务文本超过 20000 字符，dsh 模式经命令行传参会超限；请拆分任务或设 CODING_AGENT=claude 后端',
          };
        }
        const { stdout, stderr, killed, exitCode } = await runDshHeadless(taskText, {
          cwd: resolvedDir,
          timeoutMs,
          permissionMode:
            mode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write',
        });
        if (killed && exitCode === 124) {
          return {
            ok: false,
            error: `dsh 执行超过 ${Math.round(timeoutMs / 60_000)} 分钟被终止`,
          };
        }
        if (killed || exitCode !== 0) {
          return {
            ok: false,
            error: `dsh 执行失败（exit ${exitCode}）：${(stderr.trim() || stdout.trim()).slice(0, 2000)}`,
          };
        }
        return {
          ok: true,
          data: {
            text: (stdout.trim() || stderr.trim()).slice(0, 40_000),
            backend: 'dsh',
          },
        };
      }

      const key = resolvedDir.toLowerCase();
      const previousSessionId = codingSessions.get(key);
      const args = [
        '-p',
        '--output-format',
        'json',
        '--permission-mode',
        mode,
        '--add-dir',
        resolvedDir,
        ...(previousSessionId ? ['--resume', previousSessionId] : []),
      ];
      try {
        const { stdout, stderr, killed, exitCode } = await runClaudeCode(args, {
          cwd: resolvedDir,
          task: task.trim(),
          timeoutMs,
        });

        let parsed: {
          result?: unknown;
          session_id?: string;
          is_error?: boolean;
          total_cost_usd?: number;
          permission_denials?: unknown[];
        };
        try {
          parsed = JSON.parse(stdout) as typeof parsed;
        } catch {
          if (killed && exitCode === 124) {
            return {
              ok: false,
              error: `Claude Code 执行超过 ${Math.round(timeoutMs / 60_000)} 分钟被终止`,
            };
          }
          if (exitCode !== 0) {
            return {
              ok: false,
              error: `Claude Code 执行失败（exit ${exitCode}）：${(stderr.trim() || stdout.trim()).slice(0, 2000)}`,
            };
          }
          return {
            ok: true,
            data: {
              text: (stdout.trim() || stderr.trim()).slice(0, 20_000),
              sessionId: previousSessionId,
            },
          };
        }

        const text =
          typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result ?? '');
        if (parsed.session_id) {
          codingSessions.set(key, parsed.session_id);
        }
        return {
          ok: !parsed.is_error,
          data: {
            text: text.slice(0, 40_000),
            sessionId: parsed.session_id ?? previousSessionId,
            ...(typeof parsed.total_cost_usd === 'number'
              ? { costUsd: parsed.total_cost_usd }
              : {}),
            ...(parsed.permission_denials && parsed.permission_denials.length > 0
              ? { permissionDenials: parsed.permission_denials }
              : {}),
          },
        };
      } catch (error) {
        const err = error as { message?: string };
        return {
          ok: false,
          error: `Claude Code 执行失败：${(err.message || String(error)).slice(0, 2000)}`,
        };
      }
    },
  };
}
