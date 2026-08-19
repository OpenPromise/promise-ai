import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface FileInfo {
  name: string;
  size: number;
  modifiedAt: string;
}

/** 文件库根目录（WEIXIN_FILES_DIR，容器内 /data/weixin-files）。 */
export interface FileLibraryOptions {
  dir: string;
}

export function sanitizeFileName(name: string): string {
  const base = path.basename(name.trim()).replace(/[\\/]/g, '_');
  return base || 'file.bin';
}

export async function listLibraryFiles(dir: string): Promise<FileInfo[]> {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir, { withFileTypes: true });
  const files: FileInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const info = await stat(path.join(dir, entry.name));
      files.push({
        name: entry.name,
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    } catch {
      // 忽略无法读取的条目
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 按文件名查找：精确 > 前缀 > 包含（大小写不敏感）。
 * 返回匹配项；无匹配返回 undefined。
 */
export function resolveFileByName(files: FileInfo[], query: string): FileInfo | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const exact = files.find((f) => f.name.toLowerCase() === q);
  if (exact) return exact;
  const prefix = files.find((f) => f.name.toLowerCase().startsWith(q));
  if (prefix) return prefix;
  return files.find((f) => f.name.toLowerCase().includes(q));
}

export async function readLibraryFile(
  dir: string,
  name: string,
): Promise<{ name: string; bytes: Buffer } | undefined> {
  const safe = sanitizeFileName(name);
  const full = path.join(dir, safe);
  try {
    const info = await stat(full);
    if (!info.isFile()) return undefined;
    return { name: safe, bytes: await readFile(full) };
  } catch {
    return undefined;
  }
}

/** 保存入站文件到文件库（文件名消毒，防路径穿越）。 */
export async function saveLibraryFile(dir: string, name: string, bytes: Buffer): Promise<string> {
  await mkdir(dir, { recursive: true });
  const safe = sanitizeFileName(name);
  await writeFile(path.join(dir, safe), bytes);
  return safe;
}
