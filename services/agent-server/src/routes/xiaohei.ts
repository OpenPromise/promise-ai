import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * 小黑欢迎界面（深色科技感），仓库根目录 /xiaohei/index.html。
 * 用 import.meta.url 从 routes/ 向上 4 级定位 /app/xiaohei（与 health.ts
 * 中 require('../../../../package.json') 的层级一致）。
 */
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
    return reply.type('text/html; charset=utf-8').send(html);
  });
}
