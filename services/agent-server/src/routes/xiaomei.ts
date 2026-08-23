import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { safeResolve, sendStaticFile } from './static-assets.js';

/**
 * 小美欢迎主页（极简高级设计风），仓库根目录 /xiaomei/。
 * 用 import.meta.url 从 routes/ 向上 4 级定位 /app/xiaomei（与 xiaohei.ts 一致）。
 */
const xiaomeiRoot = fileURLToPath(new URL('../../../../xiaomei/', import.meta.url));
const xiaomeiHtmlPath = fileURLToPath(new URL('../../../../xiaomei/index.html', import.meta.url));

// 懒加载 + 缓存：首次请求时读取，之后复用；文件缺失只影响本路由，不阻塞服务启动。
let cachedHtml: Promise<string> | null = null;

function loadXiaomeiHtml(): Promise<string> {
  if (!cachedHtml) {
    cachedHtml = readFile(xiaomeiHtmlPath, 'utf8').catch((error) => {
      // 失败不缓存：下次请求重试，避免一次读文件失败导致永久 500
      cachedHtml = null;
      throw error;
    });
  }
  return cachedHtml;
}

export function registerXiaomeiRoutes(app: FastifyInstance): void {
  app.get('/xiaomei', async (_request, reply) => {
    const html = await loadXiaomeiHtml();
    reply.header('Cache-Control', 'no-cache, max-age=0, must-revalidate');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // /xiaomei/* 静态子资源（设计稿预览图等）：与 xiaohei 一致，为以后放图预留。
  app.get('/xiaomei/*', async (request, reply) => {
    const raw = (request.params as Record<string, string | undefined>)['*'] ?? '';
    // 尾斜杠（/xiaomei/）回落 index.html，与 /xiaomei 行为一致。
    const relative = raw === '' ? 'index.html' : raw;
    const filePath = safeResolve(xiaomeiRoot, relative);
    if (!filePath) return reply.code(404).send({ error: 'Not Found' });
    return sendStaticFile(reply, filePath);
  });
}
