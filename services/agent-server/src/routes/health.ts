import type { FastifyInstance } from 'fastify';
import type { LLMProvider } from '@personal-ai/llm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../../../../package.json') as { version: string };

export interface HealthDeps {
  llm: LLMProvider;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  // /health 无鉴权（容器 HEALTHCHECK / 反代探活要用），因此只输出探活必需的
  // 存活信息与不敏感的 LLM 装配情况；autoApproveAll / voice* / memory backend
  // 这类"能推断出安全策略与内部拓扑"的配置一律不对外暴露。
  app.get('/health', async () => ({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    version,
    llm: {
      provider: deps.llm.name,
      model: deps.llm.model,
      configured: deps.llm.configured,
    },
  }));
}
