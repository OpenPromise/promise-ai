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
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/health', async () => ({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    version,
    llm: {
      provider: deps.llm.name,
      model: deps.llm.model,
      configured: deps.llm.configured,
    },
    memory: { backend: deps.memoryBackend },
  }));
}
