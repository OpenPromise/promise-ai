import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { collectSecrets, redactOutput } from './server-shell.js';

/**
 * 小优（ops.delegate）派单审计日志：每次派单一条 JSON Lines 记录，
 * 落盘 /app/logs/ops-audit.log（可用 OPS_AUDIT_LOG_PATH 覆盖），超过上限
 * 滚动（保留一份 .1）。Leon ToolCallLogger 留痕思路的务实版：不做完整调用
 * 栈，只记派单级关键信息（时间/taskId/任务摘要/目录/退出码/结果摘要/破坏性
 * 标记/git 基线），足够故障排查与回滚时"按时间线回放"。
 *
 * 安全约束：写前对全部字符串字段脱敏（复用 server-shell 的 collectSecrets +
 * redactOutput），密钥不落盘；审计失败只 console.error，绝不阻断派单结果。
 */

export interface OpsAuditEntry {
  /** ISO 时间戳（派单完成时刻）。 */
  ts: string;
  type: 'ops.delegate';
  /** 本次派单唯一 ID（uuid），供跨日志/会话关联回放。 */
  taskId: string;
  /** 任务摘要（截断 200 字符，写前脱敏）。 */
  taskSummary: string;
  /** 工作目录（写前脱敏）。 */
  directory: string;
  /** dsh 退出码；dsh 未能启动等情况为 1。 */
  exitCode: number | null;
  timedOut: boolean;
  /** 结果/错误摘要（截断 500 字符，写前脱敏）。 */
  resultSummary: string;
  /** 启发式破坏性标记：任务文本含删除/清空/格式化等关键词时为 true（不替代人工判定）。 */
  destructive: boolean;
  /** git 基线（git rev-parse HEAD），回滚点；非 git 仓库为 null。 */
  gitHead: string | null;
}

export interface OpsAuditOptions {
  /** 日志文件路径；缺省 OPS_AUDIT_LOG_PATH 环境变量，再缺省 /app/logs/ops-audit.log。 */
  logPath?: string;
  /** 滚动阈值（字节）；缺省 5MB。 */
  maxBytes?: number;
  /** 脱敏用敏感值清单；缺省 collectSecrets(process.env)。 */
  secrets?: string[];
}

export const DEFAULT_OPS_AUDIT_LOG_PATH = '/app/logs/ops-audit.log';
/** 5MB：超过后滚动为 .1（只保留一份备份），新文件重新开始。 */
export const DEFAULT_OPS_AUDIT_MAX_BYTES = 5 * 1024 * 1024;

/** 破坏性/不可逆操作关键词（与 XIAO_YOU_PROMPT 准则 5 的清单对齐，启发式匹配）。 */
export const DESTRUCTIVE_KEYWORDS = [
  '删除',
  '清空',
  '清库',
  '格式化',
  '覆盖',
  '重置',
  '批量',
  'rm -rf',
  'drop table',
  'truncate',
];

/** 启发式判定任务是否含破坏性/不可逆操作（仅审计标记，不替代人工判定）。 */
export function isLikelyDestructive(text: string): boolean {
  const lower = text.toLowerCase();
  return DESTRUCTIVE_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()));
}

const execFileAsync = promisify(execFile);

/** 取工作目录的 git 基线（回滚点）；非 git 仓库/超时/无 git 一律返回 null，不抛错。 */
export async function resolveGitHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd,
      timeout: 3000,
      encoding: 'utf8',
    });
    const head = String(stdout).trim();
    return head || null;
  } catch {
    return null;
  }
}

/** 写队列：串行化，避免并发派单时两条记录交错写 / 同时触发滚动。 */
let writeChain: Promise<void> = Promise.resolve();

/** 超限则把当前文件滚动为 .1（覆盖更早的 .1），新文件重新开始。 */
async function rolloverIfNeeded(logPath: string, maxBytes: number): Promise<void> {
  try {
    const info = await stat(logPath);
    if (info.size < maxBytes) return;
    await rename(logPath, `${logPath}.1`);
  } catch {
    // 文件不存在（首次写入）等：无需滚动
  }
}

/** 写前脱敏：所有字符串字段里的敏感值替换为 [REDACTED]。 */
function redactAuditEntry(entry: OpsAuditEntry, secrets: string[]): OpsAuditEntry {
  if (secrets.length === 0) return entry;
  const redact = (value: string): string => redactOutput(value, secrets);
  return {
    ...entry,
    taskSummary: redact(entry.taskSummary),
    directory: redact(entry.directory),
    resultSummary: redact(entry.resultSummary),
  };
}

function defaultLogPath(): string {
  return process.env.OPS_AUDIT_LOG_PATH?.trim() || DEFAULT_OPS_AUDIT_LOG_PATH;
}

/**
 * 追加一条审计记录（JSON Lines）。自动建目录、超限滚动、写前脱敏；
 * 任何失败只 console.error 不抛出——审计绝不能拖垮派单本身。
 */
export async function appendOpsAudit(
  entry: OpsAuditEntry,
  options: OpsAuditOptions = {},
): Promise<void> {
  const logPath = path.resolve(options.logPath ?? defaultLogPath());
  const maxBytes = options.maxBytes ?? DEFAULT_OPS_AUDIT_MAX_BYTES;
  const secrets = options.secrets ?? collectSecrets();
  const run = writeChain.then(async () => {
    try {
      await mkdir(path.dirname(logPath), { recursive: true });
      await rolloverIfNeeded(logPath, maxBytes);
      const redacted = redactAuditEntry(entry, secrets);
      await appendFile(logPath, `${JSON.stringify(redacted)}\n`, 'utf8');
    } catch (error) {
      console.error(
        `[ops-audit] 写入失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  // 前一次失败不阻塞后续（链尾 catch）
  writeChain = run.catch(() => {});
  await run;
}
