import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { FastifyReply } from 'fastify';

/**
 * 静态文件 MIME 表（浏览器直取的子资源：头像图等）。
 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 把相对路径安全地解析到 root 之内；路径穿越/越界一律返回 null（调用方回 404）。
 * 调用方拿到的通配符值已被 find-my-way 解码，这里直接处理解码后的相对路径。
 */
export function safeResolve(root: string, relative: string): string | null {
  // 拒绝 .. 段（路径穿越）与绝对路径；只按段判断，foo..bar.png 这类合法文件名不受影响。
  if (relative.split('/').includes('..')) return null;
  if (relative.startsWith('/')) return null;
  const full = resolve(root, relative);
  // resolve 会把 . / .. 折叠，最终必须仍在 root 内（双重保险）。
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  return full;
}

/**
 * 读取并发送静态文件：按扩展名设置 MIME，文件不存在/是目录/越界回 404，
 * 其他错误上抛（走全局 error handler 回 500）。
 */
export async function sendStaticFile(
  reply: FastifyReply,
  filePath: string,
): Promise<FastifyReply> {
  try {
    const body = await readFile(filePath);
    const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    // 不缓存：此前 401 错误响应会被浏览器缓存住（无 Cache-Control 时），
    // 修好服务端后用户仍看到旧 401。no-cache 让浏览器每次都向服务器验证。
    reply.header('Cache-Control', 'no-cache, max-age=0, must-revalidate');
    return reply.type(type).send(body);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      return reply.code(404).send({ error: 'Not Found' });
    }
    throw error;
  }
}
