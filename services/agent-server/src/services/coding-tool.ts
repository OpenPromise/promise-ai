import { access } from 'node:fs/promises';
import { accessSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { PermissionLevel, Tool, ToolContext, ToolResult } from '@personal-ai/tools';
import { missingConfigHint } from './tool-execution.js';

/**
 * coding.run 服务端实现：在服务器（容器）上直接驱动 dsh（DeepSeek Harness）。
 * dsh 是开源底盘：插件化、可自由扩展，作为本项目唯一的编码代理后端。
 * 桌面端工具列表不再包含 coding.run——它属于"大脑"而不是"客户端外壳"。
 */

/** 缺 dsh 时的报错信息：错误即指引（缺什么/去哪配/怎么补），供 LLM 引导配置而非盲试。 */
export const DSH_NOT_FOUND_MESSAGE = `未找到 dsh，请确认容器/服务器已安装 @deepseek-ai/dsh${missingConfigHint(
  '@deepseek-ai/dsh（DeepSeek Harness 编码代理底盘）',
  '环境变量 DSH_CLI，或全局 npm 目录（如 /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js）',
  '执行 npm install -g @deepseek-ai/dsh 安装；或把 dsh 的 lib/bin.js 绝对路径写入 .env 的 DSH_CLI',
)}`;

interface CodingInput {
  directory?: string;
  task?: string;
  permissionMode?: string;
  timeoutMinutes?: number;
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

/** 流式输出回调：dsh 每产出一段 stdout/stderr 就调用一次（后台任务进度用）。 */
export type DshOutputCallback = (chunk: string, stream: 'stdout' | 'stderr') => void;

export interface RunDshOptions {
  cwd: string;
  timeoutMs: number;
  permissionMode: 'workspace-write' | 'danger-full-access';
  /** 可选：逐段实时接收子进程输出，不等待进程结束。 */
  onData?: DshOutputCallback;
  /** 可选：外部取消（上层 abort）时终止整个进程组。 */
  signal?: AbortSignal;
}

export interface DshRunResult {
  stdout: string;
  stderr: string;
  /** 是否因超时被终止（与"退出码非零"分离，不再靠 124 反推）。 */
  timedOut: boolean;
  exitCode: number;
}

/** SIGTERM 后强杀前的宽限：给 dsh 时间清理/刷盘，忽略 SIGTERM 时兜底回收。 */
const SIGKILL_GRACE_MS = 5_000;
/** GNU timeout 约定退出码：仅作信息展示，超时判定以 timedOut 为准。 */
const TIMEOUT_EXIT_CODE = 124;

function runChild(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    onData?: DshOutputCallback;
    signal?: AbortSignal;
  },
): Promise<DshRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env,
      // detached=true：dsh 自成进程组，超时/取消时对整个进程组发信号，
      // 避免 npm/tsc/vitest 等孙进程在 dsh 被杀后继续跑成孤儿（kill-tree 思路）。
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      options.onData?.(text, 'stdout');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      options.onData?.(text, 'stderr');
    });
    child.on('error', (error) => reject(error));
    // 对整个进程组发信号（Linux 负 PID；Windows 退回直杀子进程）。
    const killTree = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          child.kill(signal);
        } else {
          process.kill(-child.pid, signal);
        }
      } catch {
        child.kill(signal);
      }
    };
    const onAbort = (): void => {
      killTree('SIGTERM');
      // 5 秒宽限后仍存活则强杀（与超时路径同一套清理）
      const killer = setTimeout(() => killTree('SIGKILL'), SIGKILL_GRACE_MS);
      killer.unref?.();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      // dsh 可能忽略 SIGTERM：5s 宽限后强杀整个进程组。
      killTimer = setTimeout(() => killTree('SIGKILL'), SIGKILL_GRACE_MS);
      killTimer.unref?.();
    }, options.timeoutMs);
    timer.unref?.();
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout,
        stderr,
        timedOut,
        exitCode: timedOut ? TIMEOUT_EXIT_CODE : (code ?? 1),
      });
    });
    child.stdin.end();
  });
}

export async function runDshHeadless(
  task: string,
  options: RunDshOptions,
): Promise<DshRunResult> {
  const dshBin = resolveDshBin();
  if (!dshBin) {
    return {
      stdout: '',
      stderr: DSH_NOT_FOUND_MESSAGE,
      timedOut: false,
      exitCode: 1,
    };
  }
  return runChild(process.execPath, [dshBin, '--profile', 'headless', task], {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: { ...process.env, DSH_PERMISSION_MODE: options.permissionMode },
    onData: options.onData,
    signal: options.signal,
  });
}

export function createCodingTool(): Tool {
  return {
    name: 'coding.run',
    description:
      '把开发任务交给服务器上的 dsh（DeepSeek Harness）编程代理执行（读/写代码、跑测试、修 bug 等）。' +
      'dsh 是开源底盘：每次调用是全新会话（headless 无续接），插件化可扩展。' +
      '耗时较长（通常 30 秒到数分钟），建议在文字聊天中使用；语音会话可走 voice.delegate。' +
      'acceptEdits=工作区内写入，bypassPermissions=完全免沙箱。' +
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
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
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

      const taskText = task.trim();
      if (taskText.length > 20_000) {
        return {
          ok: false,
          error: '任务文本超过 20000 字符，经命令行传参会超限；请拆分任务后重试',
        };
      }
      const { stdout, stderr, timedOut, exitCode } = await runDshHeadless(taskText, {
        cwd: resolvedDir,
        timeoutMs,
        permissionMode:
          mode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write',
        signal: context.signal,
      });
      if (timedOut) {
        return {
          ok: false,
          error: `dsh 执行超过 ${Math.round(timeoutMs / 60_000)} 分钟被终止`,
        };
      }
      if (exitCode !== 0) {
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
    },
  };
}
