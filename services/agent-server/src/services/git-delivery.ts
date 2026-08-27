import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { withExclusiveFileLock } from './file-lock.js';

const execFileAsync = promisify(execFile);

/** compose 把仓库 bind-mount 在容器 /app（含 .git）。 */
export const DEFAULT_GIT_REPO_DIR = '/app';

/** 跨进程提交串行化。锁文件在仓库 .git 下，进程崩溃由 flock 释放。 */
export const GIT_DELIVERY_LOCK_NAME = 'promise-ai-delivery.lock';

export function gitDeliveryLockPath(cwd: string): string {
  return path.join(cwd, '.git', GIT_DELIVERY_LOCK_NAME);
}

/**
 * 两个子进程同时 commit 时用 flock 互斥。没有 .git 则不加锁直接跑
 * （deliverMailChanges 随后 snapshot 也会跳过）。
 */
export async function withGitDeliveryLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const gitDir = path.join(cwd, '.git');
  try {
    await stat(gitDir);
  } catch {
    return fn();
  }
  return withExclusiveFileLock(gitDeliveryLockPath(cwd), fn);
}


export const GIT_BOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Promise AI Bot',
  GIT_AUTHOR_EMAIL: 'bot@promise-ai.local',
  GIT_COMMITTER_NAME: 'Promise AI Bot',
  GIT_COMMITTER_EMAIL: 'bot@promise-ai.local',
} as const;

const COMMIT_MESSAGE_MAX = 72;

export interface GitStatusSnapshot {
  porcelain: string;
  capturedAt: string;
}

export interface GitDeliveryResult {
  skipped?: boolean;
  committed: boolean;
  pushed: boolean;
  hash?: string;
  files?: string[];
  commitError?: string;
  wrapNote?: string;
}

export interface SelectDeliveryCandidatesInput {
  startPorcelain: string;
  endPorcelain: string;
  /** 相对仓库根路径 → mtimeMs；缺省表示删了 / 无法 stat。 */
  mtimes: Record<string, number | undefined>;
  startedAtMs: number;
}

interface GitRun {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

async function runGit(
  cwd: string,
  args: string[],
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): Promise<GitRun> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      env: gitEnv(extraEnv),
      windowsHide: true,
      timeout: timeoutMs,
      encoding: 'utf8',
    });
    return { ok: true, exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (error) {
    const err = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    const exitCode = typeof err.code === 'number' ? err.code : err.killed ? 124 : 1;
    return {
      ok: false,
      exitCode,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

function unquotePorcelainPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\([n"\\])/g, (_, ch: string) => {
        if (ch === 'n') return '\n';
        return ch;
      });
  }
  return trimmed;
}

/**
 * 解析 `git status --porcelain`（v1）。rename/copy 同时记下新旧路径。
 * 返回 path → XY。
 */
export function parsePorcelain(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.length < 4) continue;
    const xy = rawLine.slice(0, 2);
    const rest = rawLine.slice(3);
    const isRenameOrCopy = xy.includes('R') || xy.includes('C') || rest.includes(' -> ');
    if (isRenameOrCopy) {
      const arrow = rest.lastIndexOf(' -> ');
      if (arrow >= 0) {
        const oldPath = unquotePorcelainPath(rest.slice(0, arrow));
        const newPath = unquotePorcelainPath(rest.slice(arrow + 4));
        if (oldPath) map.set(oldPath, xy);
        if (newPath) map.set(newPath, xy);
        continue;
      }
    }
    const file = unquotePorcelainPath(rest);
    if (file) map.set(file, xy);
  }
  return map;
}

function posixRel(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function basenameOf(relPath: string): string {
  const parts = posixRel(relPath).split('/');
  return parts[parts.length - 1] ?? relPath;
}

/**
 * 密钥 / 运行时噪声：即使 porcelain 里出现也不入库。
 * `.env` `.env.*` `data/` `mailboxes` `node_modules` `.git` `*.pem` `*.key` `id_*` weixin 状态 `*.tmp`
 */
export function isDeliveryNoise(relPath: string): boolean {
  const normalized = posixRel(relPath);
  if (!normalized || normalized === '.') return true;
  const parts = normalized.split('/').filter(Boolean);
  const base = basenameOf(normalized);
  if (normalized === '.env' || normalized.startsWith('.env.') || base === '.env' || base.startsWith('.env.')) {
    return true;
  }
  if (parts[0] === 'data') return true;
  if (parts.includes('mailboxes')) return true;
  if (parts.includes('node_modules')) return true;
  if (parts.includes('.git')) return true;
  if (base.endsWith('.pem') || base.endsWith('.key') || base.endsWith('.tmp')) return true;
  if (base.startsWith('id_')) return true;
  if (parts.includes('weixin-files') || parts.includes('weixin-data')) return true;
  if (parts[0] === 'weixin') return true;
  if (parts.includes('..') || path.isAbsolute(relPath)) return true;
  return false;
}

/** nested mail.ask（同事互问）不自动提交；小夜派单与 mail.send 要提交。 */
export function shouldAutoCommitMail(mail: { nested?: boolean; from: string }): boolean {
  if (mail.nested && mail.from !== 'xiaoye') return false;
  return true;
}

export function formatDeliveryCommitMessage(colleague: string, subject: string): string {
  const who = colleague.trim() || 'colleague';
  const prefix = `docs/feat(${who}): `;
  const rest = subject.replace(/\s+/g, ' ').trim();
  return `${prefix}${rest}`.slice(0, COMMIT_MESSAGE_MAX);
}

/**
 * 相对快照新增的脏路径，或开始就脏但 mtime 晚于任务开工（覆盖已脏文件被本任务改写）。
 */
export function selectDeliveryCandidates(input: SelectDeliveryCandidatesInput): string[] {
  const start = parsePorcelain(input.startPorcelain);
  const end = parsePorcelain(input.endPorcelain);
  const selected: string[] = [];
  for (const [file, xy] of end) {
    if (isDeliveryNoise(file)) continue;
    const wasDirty = start.has(file);
    if (!wasDirty) {
      selected.push(file);
      continue;
    }
    const mtime = input.mtimes[file];
    if (typeof mtime === 'number' && mtime > input.startedAtMs) {
      selected.push(file);
      continue;
    }
    // 开始就脏、本任务删掉：无法 stat，仍算本任务改动。
    if (xy.includes('D') && mtime === undefined) {
      selected.push(file);
    }
  }
  return [...new Set(selected)].sort();
}

export async function snapshotGitStatus(cwd: string): Promise<GitStatusSnapshot | undefined> {
  const result = await runGit(cwd, ['status', '--porcelain', '--untracked-files=all'], 15_000);
  if (!result.ok) return undefined;
  return { porcelain: result.stdout.replace(/\s+$/, ''), capturedAt: new Date().toISOString() };
}

export async function collectMtimes(
  cwd: string,
  files: readonly string[],
): Promise<Record<string, number | undefined>> {
  const mtimes: Record<string, number | undefined> = {};
  for (const file of files) {
    try {
      const st = await stat(path.join(cwd, file));
      mtimes[file] = st.mtimeMs;
    } catch {
      mtimes[file] = undefined;
    }
  }
  return mtimes;
}

async function filterGitignored(cwd: string, files: readonly string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const file of files) {
    const check = await runGit(cwd, ['check-ignore', '-q', '--', file], 8_000);
    // exit 0 = ignored
    if (check.ok) continue;
    kept.push(file);
  }
  return kept;
}

function outputTail(result: GitRun, cap = 240): string {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  return text.slice(-cap) || `git exit ${result.exitCode}`;
}

/**
 * 对照开工快照选出本任务脏文件，git add 这些路径后 commit + push origin HEAD。
 * 不写 git config；身份只走 GIT_AUTHOR_* / GIT_COMMITTER_*。push 失败不抛，wrapNote 带哈希。
 */
export async function deliverMailChanges(input: {
  cwd: string;
  startPorcelain: string;
  startedAt: string;
  colleague: string;
  mailSubject: string;
}): Promise<GitDeliveryResult> {
  return withGitDeliveryLock(input.cwd, () => deliverMailChangesUnlocked(input));
}

async function deliverMailChangesUnlocked(input: {
  cwd: string;
  startPorcelain: string;
  startedAt: string;
  colleague: string;
  mailSubject: string;
}): Promise<GitDeliveryResult> {
  const end = await snapshotGitStatus(input.cwd);
  if (!end) {
    return { skipped: true, committed: false, pushed: false };
  }
  const endFiles = [...parsePorcelain(end.porcelain).keys()];
  const mtimes = await collectMtimes(input.cwd, endFiles);
  const startedAtMs = Date.parse(input.startedAt);
  const raw = selectDeliveryCandidates({
    startPorcelain: input.startPorcelain,
    endPorcelain: end.porcelain,
    mtimes,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : 0,
  });
  const candidates = await filterGitignored(input.cwd, raw);
  if (candidates.length === 0) {
    return { skipped: true, committed: false, pushed: false };
  }

  const add = await runGit(input.cwd, ['add', '--', ...candidates], 20_000);
  if (!add.ok) {
    const detail = outputTail(add);
    return {
      committed: false,
      pushed: false,
      files: candidates,
      commitError: detail,
      wrapNote: `文件改了但提交失败: ${detail}`,
    };
  }

  const staged = await runGit(input.cwd, ['diff', '--cached', '--quiet'], 10_000);
  // quiet：exit 0 无暂存，exit 1 有暂存。
  if (staged.ok) {
    return { skipped: true, committed: false, pushed: false };
  }

  const message = formatDeliveryCommitMessage(input.colleague, input.mailSubject);
  const commit = await runGit(
    input.cwd,
    ['commit', '-m', message],
    30_000,
    { ...GIT_BOT_IDENTITY },
  );
  if (!commit.ok) {
    const detail = outputTail(commit);
    return {
      committed: false,
      pushed: false,
      files: candidates,
      commitError: detail,
      wrapNote: `文件改了但提交失败: ${detail}`,
    };
  }

  const head = await runGit(input.cwd, ['rev-parse', '--short', 'HEAD'], 10_000);
  const hash = head.ok ? head.stdout.trim().split(/\r?\n/)[0] : undefined;
  const push = await runGit(input.cwd, ['push', 'origin', 'HEAD'], 60_000);
  if (!push.ok) {
    return {
      committed: true,
      pushed: false,
      hash,
      files: candidates,
      wrapNote: `已提交但未推送 ${hash ?? ''}`.trim(),
    };
  }
  return { committed: true, pushed: true, hash, files: candidates };
}
