import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { safeResolve, sendStaticFile } from './static-assets.js';

/**
 * 小优欢迎主页（调皮可爱风），仓库根目录 /xiaoyou/。
 * 用 import.meta.url 从 routes/ 向上 4 级定位 /app/xiaoyou（与 xiaohei.ts 一致）。
 */
const xiaoyouRoot = fileURLToPath(new URL('../../../../xiaoyou/', import.meta.url));
const xiaoyouHtmlPath = fileURLToPath(new URL('../../../../xiaoyou/index.html', import.meta.url));

// 懒加载 + 缓存：首次请求时读取，之后复用；文件缺失只影响本路由，不阻塞服务启动。
let cachedHtml: Promise<string> | null = null;

function loadXiaoyouHtml(): Promise<string> {
  if (!cachedHtml) {
    cachedHtml = readFile(xiaoyouHtmlPath, 'utf8').catch((error) => {
      // 失败不缓存：下次请求重试，避免一次读文件失败导致永久 500
      cachedHtml = null;
      throw error;
    });
  }
  return cachedHtml;
}

export function registerXiaoyouRoutes(app: FastifyInstance): void {
  app.get('/xiaoyou', async (_request, reply) => {
    const html = await loadXiaoyouHtml();
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // /xiaoyou/* 静态资源：与 xiaohei 一致，为以后放图片等子资源预留。
  app.get('/xiaoyou/*', async (request, reply) => {
    const raw = (request.params as Record<string, string | undefined>)['*'] ?? '';
    const relative = raw === '' ? 'index.html' : raw;
    const filePath = safeResolve(xiaoyouRoot, relative);
    if (!filePath) return reply.code(404).send({ error: 'Not Found' });
    return sendStaticFile(reply, filePath);
  });
}
