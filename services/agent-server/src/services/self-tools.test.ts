import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { InMemoryMemoryStore } from '@personal-ai/memory';
import { createSelfTools } from './self-tools.js';

const execFileAsync = promisify(execFile);

describe('createSelfTools', () => {
  it('registers self.* tools with safe permission levels', () => {
    const tools = createSelfTools({ projectRoot: process.cwd(), memoryBackend: 'postgres' });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.has('self.info')).toBe(true);
    expect(byName.has('self.check')).toBe(true);
    expect(byName.has('self.refine')).toBe(true);
    expect(byName.has('self.rollback')).toBe(true);
    expect(byName.has('system.restart')).toBe(true);

    expect(byName.get('self.info')?.permissionLevel).toBe(0);
    expect(byName.get('self.check')?.permissionLevel).toBe(1);
    expect(byName.get('self.refine')?.permissionLevel).toBe(1);
    // 回滚与重启是高风险操作：L3（二次确认）。
    expect(byName.get('self.rollback')?.permissionLevel).toBe(3);
    expect(byName.get('system.restart')?.permissionLevel).toBe(3);
  });

  it('self.info reports the project root and version', async () => {
    const tools = createSelfTools({ projectRoot: process.cwd(), memoryBackend: 'postgres' });
    const info = tools.find((tool) => tool.name === 'self.info');
    expect(info).toBeDefined();
    const result = await info!.execute({}, { sessionId: 'test' });
    expect(result.ok).toBe(true);
    const data = result.data as { root: string; version: string; memoryBackend: string };
    expect(data.root).toBe(process.cwd());
    expect(data.version).toBeTruthy();
    expect(data.memoryBackend).toBe('postgres');
  });

  it('self.refine appends a rule to refinements.md and records feedback memory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'refine-'));
    const personaDir = path.join(dir, 'persona');
    const memory = new InMemoryMemoryStore();
    const tools = createSelfTools({
      projectRoot: dir,
      personaDir,
      memoryBackend: 'memory',
      memory,
    });
    const refine = tools.find((tool) => tool.name === 'self.refine')!;

    const result = await refine.execute(
      { evidence: '用户说回复太机械', rule: '回复时用更自然的语气，避免逐条列举' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);

    const content = await readFile(path.join(personaDir, 'refinements.md'), 'utf8');
    expect(content).toContain('用户说回复太机械');
    expect(content).toContain('用更自然的语气');

    const entries = await memory.list('episodic');
    expect(entries.some((entry) => entry.content.startsWith('[feedback]'))).toBe(true);
  });

  it('self.rollback rejects invalid commits and reverts a valid snapshot', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rollback-'));
    await execFileAsync('git', ['init', dir], { windowsHide: true });
    const target = path.join(dir, 'a.txt');
    await writeFile(target, 'v1', 'utf8');
    await execFileAsync('git', ['-C', dir, 'add', '.'], { windowsHide: true });
    await execFileAsync(
      'git',
      ['-C', dir, '-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-m', 'init'],
      { windowsHide: true },
    );
    const head = (
      await execFileAsync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        windowsHide: true,
      })
    ).stdout.trim();
    await writeFile(target, 'v2', 'utf8');

    const tools = createSelfTools({ projectRoot: dir });
    const rollback = tools.find((tool) => tool.name === 'self.rollback')!;

    const invalid = await rollback.execute({ commit: 'not-a-sha' }, { sessionId: 's1' });
    expect(invalid.ok).toBe(false);

    const valid = await rollback.execute({ commit: head }, { sessionId: 's1' });
    expect(valid.ok).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('v1');
  });
});
