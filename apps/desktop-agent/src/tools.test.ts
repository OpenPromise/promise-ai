import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalTools } from './tools.js';

function tool(name: string) {
  const found = createLocalTools().find((t) => t.declaration.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

describe('filesystem.read', () => {
  it('reads a text file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'read-'));
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'hello 世界', 'utf8');

    const result = await tool('filesystem.read').execute({ path: file });
    expect(result.ok).toBe(true);
    expect((result.data as { content: string }).content).toBe('hello 世界');
  });

  it('rejects directories', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'read-dir-'));
    const result = await tool('filesystem.read').execute({ path: dir });
    expect(result.ok).toBe(false);
  });
});

describe('filesystem.list', () => {
  it('lists directory contents with types', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'list-'));
    await writeFile(path.join(dir, 'b.txt'), 'x', 'utf8');
    await mkdir(path.join(dir, 'sub'));

    const result = await tool('filesystem.list').execute({ path: dir });
    expect(result.ok).toBe(true);
    const items = (result.data as { items: Array<{ name: string; type: string }> }).items;
    expect(items).toContainEqual({ name: 'b.txt', type: 'file' });
    expect(items).toContainEqual({ name: 'sub', type: 'directory' });
  });
});
