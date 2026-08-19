import type { FastifyInstance } from 'fastify';
import type { ToolRegistry } from '@personal-ai/tools';
import { DesktopToolBridge } from '../services/desktop-bridge.js';

export interface DesktopRouteDeps {
  registry: ToolRegistry;
}

export function registerDesktopRoutes(app: FastifyInstance, deps: DesktopRouteDeps): void {
  app.get('/ws/desktop', { websocket: true }, (socket) => {
    new DesktopToolBridge(deps.registry, socket);
  });
}
