import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext } from './index.js';

interface FilesystemSearchInput {
  query: string;
  root?: string;
  limit?: number;
}

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache']);
/** 递归搜索最大深度：防止意外深层目录树把搜索拖到超时。 */
const MAX_DEPTH = 8;

export interface CreateFilesystemSearchOptions {
  /** Directories tools are allowed to search. Defaults to the workspace root. */
  allowedRoots?: string[];
}

/**
 * Searches file names under an allowed root. Traversal is constrained to the
 * configured roots so the tool cannot read outside the workspace.
 */
export function createFilesystemSearchTool(options: CreateFilesystemSearchOptions = {}): Tool {
  const allowedRoots = (options.allowedRoots ?? [process.cwd()]).map((root) => path.resolve(root));

  return {
    name: 'filesystem.search',
    description: '按文件名关键词搜索文件，返回匹配文件的路径。不会搜索 node_modules、.git 等目录。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '文件名关键词（支持 * 通配，如 *.md、README*）',
        },
        root: {
          type: 'string',
          description: '起始目录（必须在允许的根目录内），默认第一个磁盘根目录',
        },
        limit: {
          type: 'number',
          description: '最多返回条数，默认 20，最大 100',
        },
      },
      required: ['query'],
    },
    permissionLevel: 0,
    async execute(input: unknown, context: ToolContext) {
      const { query, root, limit = 20 } = (input ?? {}) as FilesystemSearchInput;
      if (!query?.trim()) {
        return { ok: false, error: '缺少 query 参数' };
      }
      const capped = Math.min(Math.max(1, Math.floor(limit)), 100);

      let base: string;
      if (root) {
        base = path.resolve(root);
        if (!allowedRoots.some((allowed) => isWithin(base, allowed))) {
          return { ok: false, error: 'root 目录不在允许的工作区内' };
        }
      } else {
        base = allowedRoots[0] ?? process.cwd();
      }

      const rawQuery = query.trim();
      const pattern = toPattern(rawQuery);
      const matches: string[] = [];

      try {
        await walk(base, pattern, matches, capped, base, 0, context.signal);
        return {
          ok: true,
          data: {
            query: rawQuery,
            root: base,
            count: matches.length,
            files: matches,
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: `搜索失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPattern(query: string): RegExp {
  const escaped = query
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i');
}

async function walk(
  dir: string,
  pattern: RegExp,
  matches: string[],
  limit: number,
  base: string,
  depth: number,
  signal?: AbortSignal,
): Promise<void> {
  if (matches.length >= limit) return;
  if (signal?.aborted) throw new Error('搜索已取消');
  if (depth > MAX_DEPTH) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directories are skipped
  }

  for (const entry of entries) {
    if (matches.length >= limit) return;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), pattern, matches, limit, base, depth + 1, signal);
      continue;
    }
    if (entry.isFile() && pattern.test(entry.name)) {
      matches.push(path.relative(base, path.join(dir, entry.name)).replace(/\\/g, '/'));
    }
  }
}
