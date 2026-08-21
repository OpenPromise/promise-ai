import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
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
  timedOut: boolean;
}

export type ShellRunner = (
  command: string,
  options: { cwd: string; timeoutMs: number; signal: AbortSignal; input?: string },
) => Promise<ShellOutput>;

function defaultRunner(
  command: string,
  options: { cwd: string; timeoutMs: number; signal: AbortSignal; input?: string },
): Promise<ShellOutput> {
  return new Promise((resolve, reject) => {
    // detached=true：bash 自成进程组，超时/取消时对整个进程组发信号，
    // 保证 sleep/npm install/docker 等子进程不会成为孤儿继续跑（OpenClaw kill-tree 思路）。
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
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
      // 2 秒后仍存活则强杀，避免个别进程不响应 SIGTERM
      const killer = setTimeout(() => killTree('SIGKILL'), 2000);
      killer.unref?.();
    };
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    const timer = setTimeout(() => {
      onAbort();
    }, options.timeoutMs);
    timer.unref?.();
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      const timedOut = signal === 'SIGTERM' || signal === 'SIGKILL';
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut });
    });
    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

/** 低于该长度的取值不脱敏：替换后会大面积污染无关输出（如 "ab" 出现在任意单词里）。 */
const MIN_SECRET_LENGTH = 4;
/** 开关/占位类取值（密钥名下也常见），脱敏它们只会让输出无法阅读。 */
const NON_SECRET_VALUES = new Set(['true', 'false', 'none', 'null', 'test', 'auto']);

/**
 * 收集环境变量中的敏感值（API Key / Secret / Token / 密码），用于命令输出脱敏。
 * 防止 bot 执行 `env` / `cat .env` 后把密钥回显进会话历史（OpenClaw 输出脱敏思路）。
 * 短密钥（如 4 字符密码）同样纳入，只排除过短与开关型取值。
 */
export function collectSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    if (!trimmed || trimmed.length < MIN_SECRET_LENGTH) continue;
    if (NON_SECRET_VALUES.has(trimmed.toLowerCase())) continue;
    if (/(API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i.test(key)) {
      values.add(trimmed);
    }
  }
  // 长的先替换，避免短值先替换破坏长值匹配
  return [...values].sort((a, b) => b.length - a.length);
}

/** 把输出中的敏感值替换为占位符。 */
export function redactOutput(output: string, secrets: string[]): string {
  let result = output;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  return result;
}

/** bash 单引号包裹（处理命令里的单引号），用于安全嵌入 script -c。 */
export function shellSingleQuote(command: string): string {
  return `'${command.replace(/'/g, `'\\''`)}'`;
}

// no-control-regex 不允许源码出现控制字符转义，用运行时构造等价正则。
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, 'g');
const ANSI_OSC = new RegExp(`${ESC}][^${BEL}]*${BEL}`, 'g');
const ANSI_FE = new RegExp(`${ESC}[()][0-9A-B]`, 'g');
const ANSI_SIMPLIFIED = new RegExp(`${ESC}[=>]`, 'g');
const ANSI_SAVE_RESTORE = new RegExp(`${ESC}[78]`, 'g');
const ANSI_CURSOR = new RegExp(`${ESC}\\[[0-9]*[A-D]`, 'g');

/**
 * 清理 PTY 输出的控制字符：CRLF→LF、回车、ANSI 颜色/光标控制序列。
 * 让模型拿到干净的文本而不是一坨转义码。
 */
export function normalizePtyOutput(output: string): string {
  return output
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(ANSI_CSI, '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_FE, '')
    .replace(ANSI_SIMPLIFIED, '')
    .replace(ANSI_SAVE_RESTORE, '')
    .replace(ANSI_CURSOR, '');
}

/** 沙箱镜像（本地已有，无需拉取）；可用环境变量覆盖。 */
const SANDBOX_IMAGE = process.env.SERVER_SHELL_SANDBOX_IMAGE ?? 'infrastructure-app:latest';

/** 把命令包进隔离的一次性容器：断网、限内存/CPU、只挂 /projects。 */
function sandboxWrapper(command: string): string {
  return (
    `docker run --rm --network none --memory 256m --cpus 1 ` +
    `--entrypoint /bin/bash -v /projects:/projects:rw ` +
    `${shellSingleQuote(SANDBOX_IMAGE)} -lc ${shellSingleQuote(command)}`
  );
}

export interface ServerShellToolOptions {
  /** 测试注入：自定义命令执行器；缺省走 /bin/bash。 */
  runner?: ShellRunner;
  /** 默认工作目录（缺省 /projects 持久工作区）。 */
  defaultCwd?: string;
}

/**
 * 全局串行队列：同一时刻只执行一条 server.shell 命令。
 * 防止聊天会话与定时任务并发跑 npm install / docker build 等重命令互相干扰
 * （OpenClaw command-queue 思路的最简形态）。
 */
let shellQueue: Promise<unknown> = Promise.resolve();

function withShellLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = shellQueue.then(fn, fn);
  shellQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function createServerShellTool(
  options: ServerShellToolOptions = {},
): Tool {
  const runner = options.runner ?? defaultRunner;
  const defaultCwd = options.defaultCwd ?? '/projects';
  const executeCommand = (
    command: string,
    opts: { cwd: string; timeoutMs: number; signal: AbortSignal; input?: string },
    interactive: boolean,
    sandbox: boolean,
  ): Promise<ShellOutput> => {
    if (sandbox) return runner(sandboxWrapper(command), opts);
    if (!interactive) return runner(command, opts);
    // PTY：用 util-linux 的 script 给命令分配伪终端（容器已内置，零新依赖），
    // 适合交互式命令（提示输入/颜色/进度条等无 TTY 时行为不同的程序）。
    return runner(`script -qec ${shellSingleQuote(command)} /dev/null`, opts).then(
      (result) => ({
        ...result,
        stdout: normalizePtyOutput(result.stdout),
        stderr: normalizePtyOutput(result.stderr),
      }),
    );
  };

  return {
    name: 'server.shell',
    description:
      '在服务器容器内执行 bash 命令（相当于容器内终端，L3 系统级）。' +
      '可做任何服务器操作：git clone / npm install / 运行服务 / docker 起容器并映射端口等。' +
      '默认工作目录 /projects（宿主机持久工作区，重启不丢）。' +
      '输出最多返回 20000 字符；长任务请拆分或加大 timeoutSeconds。' +
      '命令输出中的 API 密钥等敏感值会自动脱敏为 [REDACTED]；' +
      '超时/取消会终止整个进程树，不留孤儿进程。' +
      'interactive=true 时在伪终端（PTY）下运行，适合交互式命令；' +
      'input 可写入命令标准输入（如回答交互式提示）。' +
      'sandbox=true 时在隔离的一次性容器里执行（断网、限内存/CPU、只挂 /projects），' +
      '适合执行不信任/高风险命令；开发、部署、需要网络或访问主仓库的任务' +
      '必须用默认模式（沙箱断网且碰不到 /app），sandbox 与 interactive 不能同时用。',
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
        interactive: {
          type: 'boolean',
          description:
            '是否在伪终端（PTY）下运行：交互式命令（提示输入、颜色、进度条）用 true；' +
            '普通命令默认 false',
        },
        input: {
          type: 'string',
          description: '写入命令标准输入的内容（如回答交互式提示），可选',
        },
        sandbox: {
          type: 'boolean',
          description:
            '是否在隔离沙箱容器执行（断网/限资源/不碰主系统），适合高风险命令',
        },
      },
      required: ['command'],
    },
    permissionLevel: 3 as PermissionLevel,
    timeoutMs: 5 * 60 * 1000,
    async execute(input: unknown): Promise<ToolResult> {
      const {
        command,
        cwd,
        timeoutSeconds = 60,
        interactive = false,
        sandbox = false,
        input: stdinInput,
      } = (input ?? {}) as {
        command?: string;
        cwd?: string;
        timeoutSeconds?: number;
        interactive?: boolean;
        sandbox?: boolean;
        input?: string;
      };
      if (!command?.trim()) {
        return { ok: false, error: '缺少 command 参数' };
      }
      if (sandbox && interactive) {
        return { ok: false, error: 'sandbox 与 interactive 不能同时使用' };
      }
      const resolvedCwd = cwd?.trim() || defaultCwd;
      try {
        await access(resolvedCwd);
      } catch {
        return { ok: false, error: `工作目录不存在：${resolvedCwd}` };
      }
      const timeoutMs = Math.min(Math.max(1, Math.floor(timeoutSeconds)), 300) * 1000;
      const controller = new AbortController();
      try {
        const result = await withShellLock(() =>
          executeCommand(
            command.trim(),
            {
              cwd: resolvedCwd,
              timeoutMs,
              signal: controller.signal,
              ...(stdinInput !== undefined ? { input: stdinInput } : {}),
            },
            interactive,
            sandbox,
          ),
        );
        const secrets = collectSecrets();
        const rawStdout = result.stdout;
        const rawStderr = result.stderr;
        const redactedStdout = redactOutput(rawStdout, secrets);
        const redactedStderr = redactOutput(rawStderr, secrets);
        // 密钥访问审计（OpenClaw secrets/audit 思路）：输出中出现敏感值时留痕，
        // 便于追溯"谁在什么时候让 agent 接触了密钥"。
        if (redactedStdout !== rawStdout || redactedStderr !== rawStderr) {
          console.warn(
            `[audit] server.shell 输出包含敏感密钥，已脱敏（命令：${command.trim().slice(0, 120)}）`,
          );
        }
        return {
          ok: true,
          data: {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stdout: redactedStdout.slice(0, 20_000),
            stderr: redactedStderr.slice(0, 10_000),
            note: result.timedOut
              ? `命令超过 ${Math.round(timeoutMs / 1000)} 秒被终止（已清理进程树）`
              : undefined,
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
