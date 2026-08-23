import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { safeResolve, sendStaticFile } from './static-assets.js';

/**
 * 小夜欢迎界面（月夜主题），仓库根目录 /xiaoye/。
 * 由小夜本人布置，与小黑(/xiaohei)、小优(/xiaoyou) 独立。
 */
const xiaoyeRoot = fileURLToPath(new URL('../../../../xiaoye/', import.meta.url));
const xiaoyeHtmlPath = fileURLToPath(new URL('../../../../xiaoye/index.html', import.meta.url));

let cachedHtml: Promise<string> | null = null;

function loadXiaoyeHtml(): Promise<string> {
  if (!cachedHtml) {
    cachedHtml = readFile(xiaoyeHtmlPath, 'utf8').catch((error) => {
      cachedHtml = null;
      throw error;
    });
  }
  return cachedHtml;
}

export function registerXiaoyeRoutes(app: FastifyInstance): void {
  app.get('/xiaoye', async (_request, reply) => {
    const html = await loadXiaoyeHtml();
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // 静态子资源（头像等）
  app.get('/xiaoye/*', async (request, reply) => {
    try {
      const file = safeResolve(xiaoyeRoot, request.url);
      if (!file) return reply.code(404).send('Not found');
      return await sendStaticFile(reply, file);
    } catch {
      return reply.code(404).send('Not found');
    }
  });
}
