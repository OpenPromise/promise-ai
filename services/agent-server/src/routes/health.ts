import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@personal-ai/config';
import type { LLMProvider } from '@personal-ai/llm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../../../../package.json') as { version: string };

export interface HealthDeps {
  config: AppConfig;
  llm: LLMProvider;
  memoryBackend: string;
  /** /health/detail 的访问令牌（默认复用 DESKTOP_TOKEN）；未配置则该端点关闭。 */
  detailToken?: string;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  // /health 无鉴权（容器 HEALTHCHECK / 反代探活要用），因此只输出探活必需的
  // 存活信息与不敏感的 LLM 装配情况；autoApproveAll / voice* / memory backend
  // 这类"能推断出安全策略与内部拓扑"的配置移到需要 token 的 /health/detail。
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

  app.get('/health/detail', async (request, reply) => {
    const expected = deps.detailToken?.trim() ?? '';
    const provided = request.headers['x-health-token'];
    if (!expected || typeof provided !== 'string' || provided !== expected) {
      return reply.code(401).send({ error: 'x-health-token 不匹配' });
    }
    return reply.send({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      version,
      llm: {
        provider: deps.llm.name,
        model: deps.llm.model,
        configured: deps.llm.configured,
      },
      autoApproveAll: deps.config.autoApproveAll,
      voiceEnabled: deps.config.voiceEnabled,
      voiceTtsEnabled: deps.config.voiceTtsEnabled,
      memory: { backend: deps.memoryBackend },
    });
  });
}
