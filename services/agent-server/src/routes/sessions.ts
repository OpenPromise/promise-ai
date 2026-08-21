import type { FastifyInstance } from 'fastify';
import type { PersonaProvider } from '@personal-ai/core';
import type { LLMProvider } from '@personal-ai/llm';
import { SessionNotFoundError } from '@personal-ai/memory';
import type { SessionStore } from '@personal-ai/memory';
import { createEnvelope } from '@personal-ai/protocol';
import type { ApprovalRegistry } from '../services/approval.js';
import type { ConversationService } from '../services/conversation.js';

interface SessionParams {
  id: string;
}

interface CreateSessionBody {
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
}

interface ChatBody {
  message: string;
  requestId?: string;
}

interface PermissionBody {
  requestId: string;
  approved: boolean;
  reason?: string;
}

export interface SessionRouteDeps {
  store: SessionStore;
  llm: LLMProvider;
  persona: PersonaProvider;
  conversation: ConversationService;
  approvals: ApprovalRegistry;
}

const sessionJsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    systemPrompt: { type: 'string' },
    messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          sessionId: { type: 'string' },
          role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
          content: { type: 'string' },
          createdAt: { type: 'string' },
          toolCallId: { type: 'string' },
          toolCalls: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                arguments: { type: 'string' },
              },
            },
          },
        },
      },
    },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    metadata: { type: 'object' },
  },
} as const;

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  app.post(
    '/api/sessions',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            systemPrompt: { type: 'string', maxLength: 4000 },
            metadata: { type: 'object' },
          },
          additionalProperties: false,
        },
        response: {
          201: sessionJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as CreateSessionBody;
      const systemPrompt = body.systemPrompt?.trim() || (await deps.persona.getSystemPrompt());
      const session = await deps.store.createSession({
        systemPrompt,
        metadata: body.metadata,
      });
      return reply.code(201).send(session);
    },
  );

  app.get(
    '/api/sessions/:id',
    {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: sessionJsonSchema,
          404: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const params = request.params as SessionParams;
      try {
        const session = await deps.store.getSession(params.id);
        return reply.send(session);
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return reply.code(404).send({ error: 'Session not found' });
        }
        throw error;
      }
    },
  );

  app.post(
    '/api/sessions/:id/chat',
    {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            message: { type: 'string', minLength: 1, maxLength: 20000 },
            requestId: { type: 'string', maxLength: 128 },
          },
          required: ['message'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as SessionParams;
      const body = request.body as ChatBody;

      let session;
      try {
        session = await deps.store.getSession(params.id);
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return reply.code(404).send({ error: 'Session not found' });
        }
        throw error;
      }

      if (!deps.llm.configured) {
        return reply.code(503).send({ error: 'LLM provider is not configured' });
      }

      const requestId = body.requestId ?? undefined;
      reply.hijack();

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const abortController = new AbortController();
      request.raw.once('close', () => abortController.abort());

      try {
        for await (const envelope of deps.conversation.runChat({
          sessionId: session.id,
          userMessage: body.message,
          requestId,
          signal: abortController.signal,
        })) {
          reply.raw.write(`data: ${JSON.stringify(envelope)}\n\n`);
        }
      } catch (error) {
        request.log.error({ err: error, sessionId: session.id }, 'chat stream failed');
        if (!reply.raw.writableEnded) {
          const envelope = createEnvelope({
            type: 'chat.error',
            sessionId: session.id,
            requestId,
            payload: {
              error: error instanceof Error ? error.message : 'Internal error',
            },
          });
          reply.raw.write(`data: ${JSON.stringify(envelope)}\n\n`);
        }
      } finally {
        reply.raw.end();
      }
    },
  );

  app.post(
    '/api/sessions/:id/permission',
    {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            requestId: { type: 'string', minLength: 1 },
            approved: { type: 'boolean' },
            reason: { type: 'string', maxLength: 500 },
          },
          required: ['requestId', 'approved'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as SessionParams;
      const body = request.body as PermissionBody;

      try {
        await deps.store.getSession(params.id);
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return reply.code(404).send({ error: 'Session not found' });
        }
        throw error;
      }

      // 归属校验（N-P0-3）：requestId 必须属于本会话，否则 403；
      // 未知/已过期仍是 404（区分"不是你的"与"没有这个"）。
      const resolved = deps.approvals.respond(
        body.requestId,
        {
          approved: body.approved,
          ...(body.reason?.trim() ? { reason: body.reason.trim() } : {}),
        },
        params.id,
      );
      if (resolved === 'forbidden') {
        return reply.code(403).send({ error: 'Permission request does not belong to this session' });
      }
      if (resolved === 'not_found') {
        return reply.code(404).send({ error: 'Permission request not found or expired' });
      }
      return reply.send({ resolved: true });
    },
  );
}
