import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectMtimes,
  deliverMailChanges,
  formatDeliveryCommitMessage,
  isDeliveryNoise,
  parsePorcelain,
  selectDeliveryCandidates,
  shouldAutoCommitMail,
  snapshotGitStatus,
  withGitDeliveryLock,
} from './git-delivery.js';

const execFileAsync = promisify(execFile);

describe('parsePorcelain / isDeliveryNoise / selectDeliveryCandidates', () => {
  it('parses modified, untracked, and rename lines', () => {
    const porcelain = [
      ' M xiaozhen/index.html',
      '?? xiaomei/output/notes.md',
      'R  old-name.md -> new-name.md',
      'D  gone.txt',
    ].join('\n');
    const map = parsePorcelain(porcelain);
    expect(map.get('xiaozhen/index.html')).toBe(' M');
    expect(map.get('xiaomei/output/notes.md')).toBe('??');
    expect(map.get('old-name.md')).toBe('R ');
    expect(map.get('new-name.md')).toBe('R ');
    expect(map.get('gone.txt')).toBe('D ');
  });

  it('filters secrets and runtime noise', () => {
    expect(isDeliveryNoise('.env')).toBe(true);
    expect(isDeliveryNoise('.env.local')).toBe(true);
    expect(isDeliveryNoise('data/mailboxes/xiaohei.json')).toBe(true);
    expect(isDeliveryNoise('data/foo.txt')).toBe(true);
    expect(isDeliveryNoise('services/agent-server/mailboxes/x.json')).toBe(true);
    expect(isDeliveryNoise('node_modules/foo/index.js')).toBe(true);
    expect(isDeliveryNoise('.git/config')).toBe(true);
    expect(isDeliveryNoise('certs/bot.pem')).toBe(true);
    expect(isDeliveryNoise('certs/bot.key')).toBe(true);
    expect(isDeliveryNoise('.ssh/id_ed25519')).toBe(true);
    expect(isDeliveryNoise('id_rsa')).toBe(true);
    expect(isDeliveryNoise('weixin-files/a.jpg')).toBe(true);
    expect(isDeliveryNoise('weixin-data/state.json')).toBe(true);
    expect(isDeliveryNoise('scratch.tmp')).toBe(true);
    expect(isDeliveryNoise('xiaozhen/index.html')).toBe(false);
    expect(isDeliveryNoise('services/agent-server/src/services/weixin-tools.ts')).toBe(false);
    expect(isDeliveryNoise('xiaohei/learnings.md')).toBe(false);
    expect(isDeliveryNoise('.env.example')).toBe(true);
  });

  it('selects new dirty files that were not in the start snapshot', () => {
    const start = ' M leftover.md\n?? .env';
    const end = [
      ' M leftover.md',
      '?? xiaozhen/index.html',
      ' M services/agent-server/src/app.ts',
      '?? .env',
      '?? data/secret.json',
    ].join('\n');
    const startedAtMs = 1_000;
    const selected = selectDeliveryCandidates({
      startPorcelain: start,
      endPorcelain: end,
      mtimes: {
        'leftover.md': 500,
        'xiaozhen/index.html': 2_000,
        'services/agent-server/src/app.ts': 2_000,
        '.env': 2_000,
        'data/secret.json': 2_000,
      },
      startedAtMs,
    });
    expect(selected).toEqual(['services/agent-server/src/app.ts', 'xiaozhen/index.html']);
  });

  it('includes an already-dirty file when mtime is after startedAt (小黑改已脏 index.html)', () => {
    const start = ' M xiaozhen/index.html\n M xiaohei/learnings.md';
    const end = ' M xiaozhen/index.html\n M xiaohei/learnings.md';
    const selected = selectDeliveryCandidates({
      startPorcelain: start,
      endPorcelain: end,
      mtimes: {
        'xiaozhen/index.html': 5_000,
        'xiaohei/learnings.md': 100,
      },
      startedAtMs: 1_000,
    });
    expect(selected).toEqual(['xiaozhen/index.html']);
  });

  it('does not select leftover dirty files whose mtime is unchanged', () => {
    const selected = selectDeliveryCandidates({
      startPorcelain: ' M xiaohei/learnings.md',
      endPorcelain: ' M xiaohei/learnings.md',
      mtimes: { 'xiaohei/learnings.md': 50 },
      startedAtMs: 100,
    });
    expect(selected).toEqual([]);
  });

  it('includes a deletion that appeared after the snapshot', () => {
    const selected = selectDeliveryCandidates({
      startPorcelain: '',
      endPorcelain: ' D xiaozhen/old.html',
      mtimes: {},
      startedAtMs: 1,
    });
    expect(selected).toEqual(['xiaozhen/old.html']);
  });

  it('nested mail.ask skips auto-commit; 小夜派单与 mail.send 要提交', () => {
    expect(shouldAutoCommitMail({ nested: true, from: 'xiaomei' })).toBe(false);
    expect(shouldAutoCommitMail({ nested: true, from: 'xiaozhen' })).toBe(false);
    expect(shouldAutoCommitMail({ nested: false, from: 'xiaomei' })).toBe(true);
    expect(shouldAutoCommitMail({ from: 'xiaoye' })).toBe(true);
    expect(shouldAutoCommitMail({ nested: true, from: 'xiaoye' })).toBe(true);
  });

  it('commit message stays one line and ≤72 chars', () => {
    const msg = formatDeliveryCommitMessage(
      '小黑',
      '做小真主页 v2 设计并写很长很长很长很长很长很长很长很长的说明还要再长一点直到超过七十二',
    );
    expect(msg.startsWith('docs/feat(小黑): ')).toBe(true);
    expect(msg.length).toBeLessThanOrEqual(72);
    expect(msg.includes('\n')).toBe(false);
  });
});

describe('deliverMailChanges (hermetic tmp git repo)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    // 不 rm -rf 仓库本体也可；tmp 会被系统回收。显式清以免占盘。
    dirs.length = 0;
  });

  async function initRepo(): Promise<{ work: string; bare: string }> {
    const work = await mkdtemp(path.join(tmpdir(), 'git-delivery-work-'));
    const bare = await mkdtemp(path.join(tmpdir(), 'git-delivery-bare-'));
    dirs.push(work, bare);
    await execFileAsync('git', ['init', '--bare', bare], { windowsHide: true });
    await execFileAsync('git', ['init', '-b', 'main', work], { windowsHide: true });
    await execFileAsync('git', ['-C', work, 'remote', 'add', 'origin', bare], { windowsHide: true });
    await writeFile(path.join(work, 'README.md'), 'init\n', 'utf8');
    await execFileAsync('git', ['-C', work, 'add', 'README.md'], { windowsHide: true });
    await execFileAsync(
      'git',
      ['-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'],
      { windowsHide: true },
    );
    await execFileAsync('git', ['-C', work, 'push', '-u', 'origin', 'HEAD:main'], { windowsHide: true });
    return { work, bare };
  }

  it('commits only this-task files and pushes to origin HEAD', async () => {
    const { work, bare } = await initRepo();
    await writeFile(path.join(work, 'leftover.md'), 'already dirty\n', 'utf8');
    const snap = await snapshotGitStatus(work);
    expect(snap?.porcelain).toContain('leftover.md');

    const startedAt = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await mkdir(path.join(work, 'xiaozhen'), { recursive: true });
    await writeFile(path.join(work, 'xiaozhen/index.html'), '<h1>v2</h1>\n', 'utf8');
    await writeFile(path.join(work, '.env'), 'SECRET=1\n', 'utf8');

    const result = await deliverMailChanges({
      cwd: work,
      startPorcelain: snap!.porcelain,
      startedAt,
      colleague: '小真',
      mailSubject: '做小真主页 v2',
    });
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.files).toEqual(['xiaozhen/index.html']);
    expect(result.hash).toBeTruthy();

    const show = await execFileAsync(
      'git',
      ['-C', work, 'show', '--pretty=format:%s', '--name-only', 'HEAD'],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(show.stdout).toContain('docs/feat(小真): 做小真主页 v2');
    expect(show.stdout).toContain('xiaozhen/index.html');
    expect(show.stdout).not.toContain('leftover.md');
    expect(show.stdout).not.toContain('.env');

    const author = await execFileAsync(
      'git',
      ['-C', work, 'log', '-1', '--format=%an <%ae>'],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(author.stdout.trim()).toBe('Promise AI Bot <bot@promise-ai.local>');

    const remoteLog = await execFileAsync(
      'git',
      ['-C', bare, 'log', '-1', '--format=%s', 'main'],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(remoteLog.stdout).toContain('docs/feat(小真): 做小真主页 v2');

    const leftoverStatus = await execFileAsync(
      'git',
      ['-C', work, 'status', '--porcelain'],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(leftoverStatus.stdout).toContain('leftover.md');
  });

  it('includes already-dirty file when its mtime is after startedAt', async () => {
    const { work } = await initRepo();
    await mkdir(path.join(work, 'xiaozhen'), { recursive: true });
    await writeFile(path.join(work, 'xiaozhen/index.html'), '<h1>old</h1>\n', 'utf8');
    const snap = await snapshotGitStatus(work);
    const startedAt = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path.join(work, 'xiaozhen/index.html'), '<h1>edited in task</h1>\n', 'utf8');

    const result = await deliverMailChanges({
      cwd: work,
      startPorcelain: snap!.porcelain,
      startedAt,
      colleague: '小黑',
      mailSubject: '改首页',
    });
    expect(result.committed).toBe(true);
    expect(result.files).toEqual(['xiaozhen/index.html']);
    const mtimes = await collectMtimes(work, ['xiaozhen/index.html']);
    expect(mtimes['xiaozhen/index.html']).toBeGreaterThan(Date.parse(startedAt));
  });

  it('push failure still counts as committed and sets 已提交但未推送', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'git-delivery-nopush-'));
    dirs.push(work);
    await execFileAsync('git', ['init', '-b', 'main', work], { windowsHide: true });
    await writeFile(path.join(work, 'README.md'), 'init\n', 'utf8');
    await execFileAsync('git', ['-C', work, 'add', 'README.md'], { windowsHide: true });
    await execFileAsync(
      'git',
      ['-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'],
      { windowsHide: true },
    );
    const snap = await snapshotGitStatus(work);
    const startedAt = new Date().toISOString();
    await writeFile(path.join(work, 'notes.md'), 'hello\n', 'utf8');
    const result = await deliverMailChanges({
      cwd: work,
      startPorcelain: snap!.porcelain,
      startedAt,
      colleague: '小美',
      mailSubject: '落盘笔记',
    });
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.wrapNote).toMatch(/^已提交但未推送 /);
    expect(result.hash).toBeTruthy();
    expect(result.wrapNote).toContain(result.hash);
  });

  it('does nothing when the worktree did not gain this-task files', async () => {
    const { work } = await initRepo();
    await writeFile(path.join(work, 'leftover.md'), 'still leftover\n', 'utf8');
    const snap = await snapshotGitStatus(work);
    const result = await deliverMailChanges({
      cwd: work,
      startPorcelain: snap!.porcelain,
      startedAt: new Date().toISOString(),
      colleague: '小优',
      mailSubject: '巡检',
    });
    expect(result.skipped).toBe(true);
    expect(result.committed).toBe(false);
    const log = await execFileAsync(
      'git',
      ['-C', work, 'log', '--oneline'],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(log.stdout.trim().split('\n')).toHaveLength(1);
  });
});

describe('withGitDeliveryLock', () => {
  it('two overlapping critical sections do not interleave', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'git-delivery-lock-'));
    await execFileAsync('git', ['init', '-b', 'main', work], { windowsHide: true });
    const order: number[] = [];
    await Promise.all([
      withGitDeliveryLock(work, async () => {
        order.push(1);
        await new Promise((resolve) => setTimeout(resolve, 40));
        order.push(2);
      }),
      withGitDeliveryLock(work, async () => {
        order.push(3);
        order.push(4);
      }),
    ]);
    const serialized =
      JSON.stringify(order) === '[1,2,3,4]' || JSON.stringify(order) === '[3,4,1,2]';
    expect(serialized).toBe(true);
  });
});
