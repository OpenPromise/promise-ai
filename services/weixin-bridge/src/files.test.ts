import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  deleteLibraryFile,
  listLibraryFiles,
  readLibraryFile,
  resolveFileByName,
  sanitizeFileName,
  saveLibraryFile,
} from './files.js';

describe('sanitizeFileName', () => {
  it('strips path components and rejects traversal', () => {
    expect(sanitizeFileName('报告.pdf')).toBe('报告.pdf');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('a\\b\\c.txt')).toBe(
      process.platform === 'win32' ? 'c.txt' : 'a_b_c.txt',
    );
    expect(sanitizeFileName('   ')).toBe('file.bin');
  });
});

describe('resolveFileByName', () => {
  const files = [
    { name: '报告.pdf', size: 1, modifiedAt: '' },
    { name: 'photos-2026.zip', size: 2, modifiedAt: '' },
    { name: 'notes.txt', size: 3, modifiedAt: '' },
  ];

  it('matches exact > prefix > contains', () => {
    expect(resolveFileByName(files, '报告.pdf')?.name).toBe('报告.pdf');
    expect(resolveFileByName(files, 'photos')?.name).toBe('photos-2026.zip');
    expect(resolveFileByName(files, 'notes')?.name).toBe('notes.txt');
    expect(resolveFileByName(files, '不存在')?.name).toBeUndefined();
  });
});

describe('library file IO', () => {
  it('lists, saves and reads files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wxfiles-'));
    const saved = await saveLibraryFile(dir, 'hello.txt', Buffer.from('你好'));
    expect(saved).toBe('hello.txt');

    const files = await listLibraryFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('hello.txt');
    expect(files[0]?.size).toBe(6);

    const loaded = await readLibraryFile(dir, 'hello.txt');
    expect(loaded?.bytes.toString()).toBe('你好');
    expect(await readLibraryFile(dir, 'missing.txt')).toBeUndefined();

    // 穿越路径只落在库内
    const evil = await saveLibraryFile(dir, '../evil.txt', Buffer.from('x'));
    expect(evil).toBe('evil.txt');
    expect(await readFile(path.join(dir, 'evil.txt'), 'utf8')).toBe('x');
  });

  it('deletes only on an exact file name, and lists candidates otherwise', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wxfiles-del-'));
    await saveLibraryFile(dir, '到底丢失了几只羊.pptx', Buffer.from('x'));
    await saveLibraryFile(dir, '到底丢失了几只羊-v2.pptx', Buffer.from('x'));

    // 模糊词不删：永久删除必须给出完整文件名，错误信息里带候选
    await expect(deleteLibraryFile(dir, '到底丢失了几只羊')).rejects.toThrow(/完整文件名/);
    await expect(deleteLibraryFile(dir, '到底丢失了几只羊')).rejects.toThrow(/-v2\.pptx/);
    expect(await listLibraryFiles(dir)).toHaveLength(2);

    const deleted = await deleteLibraryFile(dir, '到底丢失了几只羊.pptx');
    expect(deleted).toBe('到底丢失了几只羊.pptx');
    expect(await listLibraryFiles(dir)).toHaveLength(1);

    await expect(deleteLibraryFile(dir, '不存在的')).rejects.toThrow(/找不到/);
  });
});
