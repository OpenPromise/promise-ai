import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryStore } from '@personal-ai/memory';
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

async function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      timeout: timeoutMs,
      encoding: 'utf8',
    });
    return { ok: true, exitCode: 0, output: (stdout.trim() + '\n' + stderr.trim()).trim() };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    return {
      ok: false,
      exitCode: err.code ?? 1,
      output: [err.stdout ?? '', err.stderr ?? ''].join('\n').trim(),
    };
  }
}

/** 当前 git HEAD 短哈希；非 git 仓库返回 undefined。 */
async function currentHead(cwd: string): Promise<string | undefined> {
  const result = await runGit(cwd, ['rev-parse', '--short', 'HEAD'], 10_000);
  return result.ok ? result.output.split(/\r?\n/)[0]?.trim() || undefined : undefined;
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

/** 本进程内最近一次 self.check 是否通过（self.apply 的激活门禁）。 */
let lastSelfCheckPassed = false;

/**
 * 自我开发相关工具：
 * - self.info：项目根目录/版本/环境（L0）
 * - self.check：跑 typecheck + 测试，作为改动前后的健康门禁（L1）
 * - self.commit：把自我开发改动提交并推送到 GitHub（L1）
 * - self.apply：self.check 通过后激活自我开发改动（L1 自动重启，无需人工确认）
 * - self.refine：证据驱动的小步改进，追加经验规则 + 反馈记忆 + git 快照（L1）
 * - self.rollback：回滚到指定 git 提交（L3，需用户确认）
 * - system.restart：优雅重启服务，让代码改动生效（L3 需用户确认）
 */
export function createSelfTools(
  options: {
    projectRoot?: string;
    memoryBackend?: string;
    /** 用于 self.refine 写入 [feedback] 记忆。 */
    memory?: MemoryStore;
    /** 经验规则追加目录（默认 <projectRoot>/persona）。 */
    personaDir?: string;
  } = {},
): Tool[] {
  const projectRoot = options.projectRoot ?? process.cwd();
  const memoryBackend = options.memoryBackend ?? 'unknown';
  const memory = options.memory;
  const personaDir = options.personaDir ?? path.join(projectRoot, 'persona');

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
            codingAgent: 'dsh',
            memoryBackend,
          },
        };
      },
    },
    {
      name: 'self.check',
      description:
        '对项目自身运行类型检查（npm run typecheck）与测试（npm test），' +
        '返回各自的退出码与输出摘要。自我开发改动后必须调用并保证通过；' +
        '建议每次自我开发前填写 goal 明确目标，并按 maxIterations 控制迭代预算' +
        '（Prime Agent 有界自主思路：目标+预算+质量门）。',
      inputSchema: {
        type: 'object',
        properties: {
          full: {
            type: 'boolean',
            description: 'true=返回完整输出；false=只返回摘要（默认）',
          },
          goal: {
            type: 'string',
            description: '本次改动的目标（一句话）。自我开发前填写，用于约束范围与复盘。',
          },
          maxIterations: {
            type: 'integer',
            description: '本次自我开发允许的最大改动-验证迭代次数（默认 3）。超出必须停止并报告。',
            minimum: 1,
            maximum: 10,
          },
        },
        required: [],
      },
      permissionLevel: 1 as PermissionLevel,
      timeoutMs: 5 * 60 * 1000,
      async execute(input: unknown): Promise<ToolResult> {
        const { full, goal, maxIterations } = (input ?? {}) as {
          full?: boolean;
          goal?: string;
          maxIterations?: number;
        };
        const typecheck = await runNpm(projectRoot, ['run', 'typecheck'], 180_000);
        const test = await runNpm(projectRoot, ['test'], 240_000);
        const summarize = (result: RunResult, label: string): string => {
          const summary = label === 'test' ? extractTestSummary(result.output) : undefined;
          const tail = (summary ?? result.output).slice(-1200);
          return `[${label}] exit=${result.exitCode} ${full ? result.output.slice(-4000) : tail}`;
        };
        const ok = typecheck.ok && test.ok;
        lastSelfCheckPassed = ok;
        return {
          ok,
          data: {
            typecheck: summarize(typecheck, 'typecheck'),
            test: summarize(test, 'test'),
            passed: ok,
            ...(goal?.trim() ? { goal: goal.trim() } : {}),
            budget: {
              maxIterations: maxIterations ?? 3,
              qualityGate: 'typecheck + 测试全部通过',
              stopCondition: '达到迭代预算或质量门失败时停止，回滚到基线并报告',
            },
          },
          ...(!ok ? { error: 'self.check 未全部通过，请修复后再继续' } : {}),
        };
      },
    },
    {
      name: 'self.apply',
      description:
        '激活自我开发产生的代码改动：仅当本进程内最近一次 self.check 已通过' +
        '才允许；随后优雅重启服务（约 10 秒），由守护进程/容器自动拉起，' +
        '新工具/新代码立即生效。完成后明确告诉用户已生效及如何使用。',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '应用原因，例如"新增 weixin.md5 工具"' },
        },
        required: ['reason'],
      },
      permissionLevel: 1 as PermissionLevel,
      timeoutMs: 15_000,
      async execute(input: unknown): Promise<ToolResult> {
        if (!lastSelfCheckPassed) {
          return { ok: false, error: 'self.check 尚未通过，禁止应用未验证的改动' };
        }
        const { reason } = (input ?? {}) as { reason?: string };
        setTimeout(() => process.exit(0), 10_000);
        return {
          ok: true,
          data: {
            restarting: true,
            reason: reason?.trim() || 'self-apply',
            note: 'self.check 已通过，服务将在 10 秒后重启激活改动；重启后请告诉用户新能力已生效',
          },
        };
      },
    },
    {
      name: 'self.commit',
      description:
        '把当前自我开发的改动提交并推送到 GitHub（origin/main）。' +
        '建议先 self.check 通过再调用；无改动时返回提示。' +
        '提交信息用一句话描述改动（如"新增 weixin.md5 工具"）。',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '提交说明' },
          push: {
            type: 'boolean',
            description: '是否推送到远程，默认 true',
          },
        },
        required: ['message'],
      },
      permissionLevel: 1 as PermissionLevel,
      timeoutMs: 90_000,
      async execute(input: unknown): Promise<ToolResult> {
        const { message, push = true } = (input ?? {}) as { message?: string; push?: boolean };
        if (!message?.trim()) return { ok: false, error: '缺少 message 参数' };

        const status = await runGit(projectRoot, ['status', '--porcelain'], 15_000);
        if (status.ok && status.output.length === 0) {
          return { ok: true, data: { committed: false, note: '工作区无改动，无需提交' } };
        }

        const add = await runGit(projectRoot, ['add', '-A'], 15_000);
        if (!add.ok) return { ok: false, error: `git add 失败：${add.output.slice(-300)}` };
        const commit = await runGit(
          projectRoot,
          [
            '-c',
            'user.name=Promise AI Bot',
            '-c',
            'user.email=bot@promise-ai.local',
            'commit',
            '-m',
            message.trim(),
          ],
          30_000,
        );
        if (!commit.ok)
          return { ok: false, error: `git commit 失败：${commit.output.slice(-300)}` };
        const head = await runGit(projectRoot, ['rev-parse', '--short', 'HEAD'], 10_000);

        let pushed = false;
        if (push) {
          const pushRes = await runGit(projectRoot, ['push', 'origin', 'main'], 60_000);
          pushed = pushRes.ok;
          if (!pushed) {
            return {
              ok: true,
              data: {
                committed: true,
                commit: head.ok ? head.output.split(/\r?\n/)[0] : undefined,
                pushed: false,
                note: '已提交但推送失败（可能未配置远程/网络问题），可稍后手动推送',
              },
            };
          }
        }
        return {
          ok: true,
          data: {
            committed: true,
            commit: head.ok ? head.output.split(/\r?\n/)[0] : undefined,
            pushed,
            note: pushed ? '已提交并推送到 GitHub（origin/main）' : '已提交（未推送）',
          },
        };
      },
    },
    {
      name: 'self.refine',
      description:
        '证据驱动的自我改进（Prime /refine 思路）：把一条失败证据或用户反馈提炼成' +
        '一条小规则，只追加到 persona/refinements.md（不改写基础人设），并写入 ' +
        '[feedback] 长期记忆；返回当前 git 快照作为回滚点。每次只沉淀一条规则。' +
        '注意：工具结果已带 [失败分类] 标注——"可恢复"（超时/网络/文件未就绪）' +
        '不应沉淀成"禁用某工具"的规则，只有"工具/参数缺陷"才值得写教训。',
      inputSchema: {
        type: 'object',
        properties: {
          evidence: {
            type: 'string',
            description: '失败证据或用户反馈：发生了什么、期望是什么',
          },
          rule: {
            type: 'string',
            description: '提炼出的一条可执行规则（一句话，正面表述）',
          },
        },
        required: ['evidence', 'rule'],
      },
      permissionLevel: 1 as PermissionLevel,
      async execute(input: unknown): Promise<ToolResult> {
        const { evidence, rule } = (input ?? {}) as { evidence?: string; rule?: string };
        if (!evidence?.trim() || !rule?.trim()) {
          return { ok: false, error: '缺少 evidence 或 rule 参数' };
        }

        const snapshot = await currentHead(projectRoot);
        const refinementsPath = path.join(personaDir, 'refinements.md');
        await mkdir(personaDir, { recursive: true });
        const date = new Date().toISOString().slice(0, 10);
        await appendFile(
          refinementsPath,
          `- [${date}] 证据：${evidence.trim()} → 规则：${rule.trim()}\n`,
          'utf8',
        );

        let memoryEntry: { id: string; kind: string } | undefined;
        if (memory) {
          const added = await memory.add({
            kind: 'episodic',
            content: `[feedback] ${evidence.trim()}（规则：${rule.trim()}）`,
          });
          memoryEntry = { id: added.id, kind: added.kind };
        }

        return {
          ok: true,
          data: {
            snapshot: snapshot ?? 'n/a（非 git 仓库，无快照）',
            refinementsFile: refinementsPath,
            rule: rule.trim(),
            ...(memoryEntry ? { memory: memoryEntry } : {}),
            ...(snapshot ? { rollback: `git reset --hard ${snapshot}` } : {}),
            note: '已追加到经验层（新会话生效）；如需撤销请用 self.rollback 回滚到 snapshot',
          },
        };
      },
    },
    {
      name: 'self.rollback',
      description:
        '把项目源码回滚到指定 git 提交（Prime 快照回滚）。高危操作：未提交的本地改动' +
        '会被丢弃；执行前需要用户确认（L3）。回滚后调用 system.restart 让服务加载旧代码。',
      inputSchema: {
        type: 'object',
        properties: {
          commit: {
            type: 'string',
            description: '目标提交哈希（来自 self.refine 返回的 snapshot）',
          },
        },
        required: ['commit'],
      },
      permissionLevel: 3 as PermissionLevel,
      timeoutMs: 60_000,
      async execute(input: unknown): Promise<ToolResult> {
        const { commit } = (input ?? {}) as { commit?: string };
        const sha = commit?.trim() ?? '';
        if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
          return {
            ok: false,
            error: 'commit 必须是 git 提交哈希（如 self.refine 返回的 snapshot）',
          };
        }
        const result = await runGit(projectRoot, ['reset', '--hard', sha], 60_000);
        return {
          ok: result.ok,
          data: { commit: sha, output: result.output.slice(-2000) },
          ...(result.ok
            ? { note: '已回滚，调用 system.restart 让改动生效' }
            : { error: `git reset --hard ${sha} 失败` }),
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
