import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { safeResolve, sendStaticFile } from './static-assets.js';

/**
 * 小黑欢迎界面（深色科技感），仓库根目录 /xiaohei/。
 * 用 import.meta.url 从 routes/ 向上 4 级定位 /app/xiaohei（与 health.ts
 * 中 require('../../../../package.json') 的层级一致）。
 */
const xiaoheiRoot = fileURLToPath(new URL('../../../../xiaohei/', import.meta.url));
const xiaoheiHtmlPath = fileURLToPath(new URL('../../../../xiaohei/index.html', import.meta.url));

// 懒加载 + 缓存：首次请求时读取，之后复用；文件缺失只影响本路由，不阻塞服务启动。
let cachedHtml: Promise<string> | null = null;

function loadXiaoheiHtml(): Promise<string> {
  if (!cachedHtml) {
    cachedHtml = readFile(xiaoheiHtmlPath, 'utf8').catch((error) => {
      // 失败不缓存：下次请求重试，避免一次读文件失败导致永久 500
      cachedHtml = null;
      throw error;
    });
  }
  return cachedHtml;
}

export function registerXiaoheiRoutes(app: FastifyInstance): void {
  app.get('/xiaohei', async (_request, reply) => {
    const html = await loadXiaoheiHtml();
    reply.header('Cache-Control', 'no-cache, max-age=0, must-revalidate');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // /xiaohei/* 静态资源（avatar.png 等）：浏览器直取，无数据无副作用，
  // 与 auth.ts 的子路径豁免配套（/xiaohei/avatar.png 不再被鉴权拦截）。
  app.get('/xiaohei/*', async (request, reply) => {
    const raw = (request.params as Record<string, string | undefined>)['*'] ?? '';
    // 尾斜杠（/xiaohei/）回落 index.html，与 /xiaohei 行为一致。
    const relative = raw === '' ? 'index.html' : raw;
    const filePath = safeResolve(xiaoheiRoot, relative);
    if (!filePath) return reply.code(404).send({ error: 'Not Found' });
    return sendStaticFile(reply, filePath);
  });
}
