import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendOpsAudit, isLikelyDestructive, type OpsAuditEntry } from './ops-audit.js';

function makeEntry(overrides: Partial<OpsAuditEntry> = {}): OpsAuditEntry {
  return {
    ts: '2026-08-23T00:00:00.000Z',
    type: 'ops.delegate',
    taskId: '11111111-1111-1111-1111-111111111111',
    taskSummary: '查看服务器时间',
    directory: '/app',
    exitCode: 0,
    timedOut: false,
    resultSummary: 'ok',
    destructive: false,
    gitHead: '3d5393886387e5a72721d2b39f8622fdac23ed92',
    ...overrides,
  };
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempLog(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ops-audit-'));
  tempDirs.push(dir);
  return path.join(dir, 'ops-audit.log');
}

describe('appendOpsAudit（JSON Lines 追加写）', () => {
  it('两条记录两行，字段完整（时间/taskId/任务摘要/目录/退出码/结果摘要/破坏性标记/git 基线）', async () => {
    const logPath = await makeTempLog();
    await appendOpsAudit(makeEntry(), { logPath });
    await appendOpsAudit(
      makeEntry({ ts: '2026-08-23T00:00:01.000Z', taskId: '22222222-2222-2222-2222-222222222222' }),
      { logPath },
    );
    const raw = await readFile(logPath, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as OpsAuditEntry;
    expect(first.type).toBe('ops.delegate');
    expect(first.taskId).toBe('11111111-1111-1111-1111-111111111111');
    expect(first.taskSummary).toBe('查看服务器时间');
    expect(first.directory).toBe('/app');
    expect(first.exitCode).toBe(0);
    expect(first.timedOut).toBe(false);
    expect(first.destructive).toBe(false);
    expect(first.gitHead).toMatch(/^[0-9a-f]{40}$/);
  });

  it('写前脱敏：条目里的密钥值替换为 [REDACTED]，不落盘', async () => {
    const logPath = await makeTempLog();
    const entry = makeEntry({
      taskSummary: '把 sk-abc-1234567890 写入配置并重启服务',
      resultSummary: '完成 sk-abc-1234567890 配置',
    });
    await appendOpsAudit(entry, { logPath, secrets: ['sk-abc-1234567890'] });
    const raw = await readFile(logPath, 'utf8');
    expect(raw).not.toContain('sk-abc-1234567890');
    expect(raw).toContain('[REDACTED]');
  });

  it('超过大小上限滚动：旧记录进 .1，新文件重新开始', async () => {
    const logPath = await makeTempLog();
    await appendOpsAudit(makeEntry(), { logPath, maxBytes: 10 });
    await appendOpsAudit(
      makeEntry({ taskId: '22222222-2222-2222-2222-222222222222' }),
      { logPath, maxBytes: 10 },
    );
    const rotated = await readFile(`${logPath}.1`, 'utf8');
    const current = await readFile(logPath, 'utf8');
    expect(rotated).toContain('11111111-1111-1111-1111-111111111111');
    expect(current).toContain('22222222-2222-2222-2222-222222222222');
    expect(current).not.toContain('11111111-1111-1111-1111-111111111111');
  });

  it('日志目录不存在时自动创建', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ops-audit-parent-'));
    tempDirs.push(dir);
    const logPath = path.join(dir, 'nested', 'ops-audit.log');
    await appendOpsAudit(makeEntry(), { logPath });
    const raw = await readFile(logPath, 'utf8');
    expect(raw).toContain('ops.delegate');
  });
});

describe('isLikelyDestructive（破坏性标记启发式）', () => {
  it('含删除/清空/格式化等关键词判定为破坏性', () => {
    expect(isLikelyDestructive('删除 /tmp/old-logs')).toBe(true);
    expect(isLikelyDestructive('格式化磁盘')).toBe(true);
    expect(isLikelyDestructive('清空数据库表')).toBe(true);
    expect(isLikelyDestructive('rm -rf /var/tmp/cache')).toBe(true);
  });

  it('纯查询/查看类任务不是破坏性', () => {
    expect(isLikelyDestructive('查看服务器时间')).toBe(false);
    expect(isLikelyDestructive('巡检磁盘使用率')).toBe(false);
    expect(isLikelyDestructive('查看端口占用')).toBe(false);
  });
});
