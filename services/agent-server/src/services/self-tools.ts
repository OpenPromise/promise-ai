import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import type { PermissionLevel, Tool, ToolResult } from '@personal-ai/tools';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

function readVersion(): string {
  try {
    const { version } = require('../../../../package.json') as { version: string };
    return version;
  } catch {
    return 'unknown';
  }
}

interface RunResult {
  ok: boolean;
  exitCode: number;
  output: string;
}

async function runNpm(cwd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('npm', args, {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      timeout: timeoutMs,
      encoding: 'utf8',
    });
    return { ok: true, exitCode: 0, output: (stdout.trim() + '\n' + stderr.trim()).trim() };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    const timedOut = err.killed === true;
    const output = [
      err.stdout ?? '',
      err.stderr ?? '',
      timedOut ? `（执行超过 ${Math.round(timeoutMs / 1000)} 秒被终止）` : '',
    ]
      .join('\n')
      .trim();
    return { ok: false, exitCode: timedOut ? 124 : (err.code ?? 1), output };
  }
}

/** 从 vitest 输出里提取测试统计行（如 "Tests  152 passed | 3 skipped"）。 */
function extractTestSummary(output: string): string | undefined {
  const match = output.match(/Tests\s+\d+ passed[^\n]*/);
  return (
    match?.[0]?.trim() ??
    output
      .split('\n')
      .filter((l) => l.includes('passed'))
      .pop()
  );
}

/**
 * 自我开发相关工具：
 * - self.info：项目根目录/版本/环境（L0）
 * - self.check：跑 typecheck + 测试，作为改动前后的健康门禁（L1）
 * - system.restart：优雅重启服务，让代码改动生效（L3 需用户确认）
 */
export function createSelfTools(
  options: {
    projectRoot?: string;
    memoryBackend?: string;
  } = {},
): Tool[] {
  const projectRoot = options.projectRoot ?? process.cwd();
  const memoryBackend = options.memoryBackend ?? 'unknown';

  return [
    {
      name: 'self.info',
      description:
        '返回本项目（AI 助理自身）的信息：项目根目录、版本号、Node 版本、平台、' +
        '记忆后端与 coding 后端。开发/更新自己之前先调用它确认工作目录。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0 as PermissionLevel,
      async execute(): Promise<ToolResult> {
        return {
          ok: true,
          data: {
            root: projectRoot,
            version: readVersion(),
            node: process.version,
            platform: process.platform,
            codingAgent: process.env.CODING_AGENT ?? 'dsh',
            memoryBackend,
          },
        };
      },
    },
    {
      name: 'self.check',
      description:
        '对项目自身运行类型检查（npm run typecheck）与测试（npm test），' +
        '返回各自的退出码与输出摘要。自我开发改动后必须调用并保证通过。',
      inputSchema: {
        type: 'object',
        properties: {
          full: {
            type: 'boolean',
            description: 'true=返回完整输出；false=只返回摘要（默认）',
          },
        },
        required: [],
      },
      permissionLevel: 1 as PermissionLevel,
      timeoutMs: 5 * 60 * 1000,
      async execute(input: unknown): Promise<ToolResult> {
        const { full } = (input ?? {}) as { full?: boolean };
        const typecheck = await runNpm(projectRoot, ['run', 'typecheck'], 180_000);
        const test = await runNpm(projectRoot, ['test'], 240_000);
        const summarize = (result: RunResult, label: string): string => {
          const summary = label === 'test' ? extractTestSummary(result.output) : undefined;
          const tail = (summary ?? result.output).slice(-1200);
          return `[${label}] exit=${result.exitCode} ${full ? result.output.slice(-4000) : tail}`;
        };
        const ok = typecheck.ok && test.ok;
        return {
          ok,
          data: {
            typecheck: summarize(typecheck, 'typecheck'),
            test: summarize(test, 'test'),
            passed: ok,
          },
          ...(!ok ? { error: 'self.check 未全部通过，请修复后再继续' } : {}),
        };
      },
    },
    {
      name: 'system.restart',
      description:
        '优雅重启 Agent Server（让代码改动生效）。重启由守护进程/容器自动拉起；' +
        '重启期间服务会短暂不可用（约 5-15 秒），完成后需要重新连接。',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '重启原因，例如"应用 self.update 改动"' },
        },
        required: [],
      },
      permissionLevel: 3 as PermissionLevel,
      timeoutMs: 15_000,
      async execute(input: unknown): Promise<ToolResult> {
        const { reason } = (input ?? {}) as { reason?: string };
        // 留出时间让 LLM 把确认回复流式送达客户端，再优雅退出。
        setTimeout(() => process.exit(0), 6000);
        return {
          ok: true,
          data: {
            restarting: true,
            reason: reason?.trim() || 'self-update',
            note: '服务将在 6 秒后重启，由守护进程自动拉起',
          },
        };
      },
    },
  ];
}
