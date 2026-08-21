import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { ElevenLabsAbortError, type VoiceGateway } from '@personal-ai/elevenlabs';
import type { SessionStore } from '@personal-ai/memory';
import { createEnvelope } from '@personal-ai/protocol';
import { randomUUID } from 'node:crypto';
import type { ApprovalRegistry } from '../services/approval.js';
import type { ConversationService } from '../services/conversation.js';
import { splitSentences } from '../services/sentences.js';
import { isApiTokenValid, type ApiAuthDeps } from './auth.js';

interface VoiceParams {
  sessionId: string;
}

export interface VoiceRouteDeps {
  store: SessionStore;
  conversation: ConversationService;
  approvals: ApprovalRegistry;
  createVoice: () => VoiceGateway;
  /** API 共享 token 鉴权配置（WebSocket 升级用路由级 preValidation）。 */
  auth?: ApiAuthDeps;
}

interface VoiceTask {
  controller: AbortController;
  /**
   * 本轮对话的请求 id。审批记忆以 requestId 为作用域（approval.ts 的
   * #requestApproved），按连接生成会把"仅本次允许"放大成"整通电话允许"，
   * 因此每轮新建一个。
   */
  requestId: string;
  synthesized: string[];
}

export function registerVoiceRoutes(app: FastifyInstance, deps: VoiceRouteDeps): void {
  app.get(
    '/ws/voice/:sessionId',
    {
      websocket: true,
    },
    (socket, request) => {
    // WebSocket 升级钩子在 @fastify/websocket 下不可靠，handler 内再校验一次
    if (deps.auth && !isApiTokenValid(request, deps.auth)) {
      socket.close(1008, 'unauthorized');
      return;
    }
    const { sessionId } = (request.params ?? {}) as VoiceParams;
    // 连接级 id：只用于与具体对话轮无关的信封（voice.ready / transcript / 错误）。
    const connectionId = randomUUID();
    const voice = deps.createVoice();
    const sendJson = (payload: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    };

    let activeTask: VoiceTask | undefined;

    /**
     * 打断：等部分回复真正落库后再发 tts.interrupted。fire-and-forget 写入
     * 可能排到下一轮 user 消息之后，导致历史顺序错乱（助手先答后问）。
     */
    const interrupt = async (reason: string): Promise<void> => {
      const task = activeTask;
      if (!task) return;
      activeTask = undefined;
      task.controller.abort();
      request.log.info({ sessionId, reason }, 'voice task interrupted');
      const partialText = task.synthesized.join('').trim();
      if (partialText) {
        try {
          await deps.store.addMessage(sessionId, {
            role: 'assistant',
            content: partialText,
          });
        } catch (error) {
          request.log.error({ err: error, sessionId }, 'failed to persist partial reply');
        }
      }
      sendJson(
        createEnvelope({
          type: 'tts.interrupted',
          sessionId,
          requestId: task.requestId,
          payload: { reason },
        }),
      );
    };

    const synthesizeAndStream = async (text: string, task: VoiceTask): Promise<void> => {
      for await (const chunk of voice.tts.synthesize(text, { signal: task.controller.signal })) {
        if (task.controller.signal.aborted) break;
        sendJson({
          type: 'audio.chunk',
          timestamp: new Date().toISOString(),
          sessionId,
          requestId: task.requestId,
          payload: { data: chunk.data.toString('base64'), format: chunk.format },
    },
  );
}
    };

    const runVoiceTask = async (userText: string): Promise<void> => {
      if (activeTask) {
        request.log.warn({ sessionId }, 'dropping final transcript while busy');
        return;
      }

      const task: VoiceTask = {
        controller: new AbortController(),
        requestId: randomUUID(),
        synthesized: [],
      };
      const requestId = task.requestId;
      activeTask = task;

      sendJson(
        createEnvelope({
          type: 'agent.thinking',
          sessionId,
          requestId,
          payload: {},
        }),
      );

      try {
        let buffer = '';
        let fullText = '';
        let ttsStarted = false;

        for await (const envelope of deps.conversation.runChat({
          sessionId,
          userMessage: userText,
          requestId,
          signal: task.controller.signal,
        })) {
          if (envelope.type !== 'chat.token') {
            // Forward state / permission / tool events to the desktop so the
            // orb and chat window can react (approve, show thinking, …).
            sendJson(envelope);
            continue;
          }
          const delta = (envelope.payload as { delta?: string }).delta ?? '';
          if (!delta) continue;
          fullText += delta;
          buffer += delta;

          const { sentences, rest } = splitSentences(buffer);
          buffer = rest;
          for (const sentence of sentences) {
            if (task.controller.signal.aborted) return;
            sendJson(
              createEnvelope({
                type: 'tts.sentence',
                sessionId,
                requestId,
                payload: { text: sentence },
              }),
            );
            if (!ttsStarted) {
              sendJson(
                createEnvelope({
                  type: 'tts.start',
                  sessionId,
                  requestId,
                  payload: { text: sentence },
                }),
              );
              sendJson(
                createEnvelope({
                  type: 'agent.state',
                  sessionId,
                  requestId,
                  payload: { state: 'speaking' },
                }),
              );
              ttsStarted = true;
            }
            await synthesizeAndStream(sentence, task);
            task.synthesized.push(sentence);
          }
        }

        if (task.controller.signal.aborted) return;
        const tail = buffer.trim();
        if (tail) {
          sendJson(
            createEnvelope({
              type: 'tts.sentence',
              sessionId,
              requestId,
              payload: { text: tail },
            }),
          );
          if (!ttsStarted) {
            sendJson(
              createEnvelope({
                type: 'tts.start',
                sessionId,
                requestId,
                payload: { text: tail },
              }),
            );
            sendJson(
              createEnvelope({
                type: 'agent.state',
                sessionId,
                requestId,
                payload: { state: 'speaking' },
              }),
            );
            ttsStarted = true;
          }
          await synthesizeAndStream(tail, task);
          if (task.controller.signal.aborted) return;
          task.synthesized.push(tail);
        }

        sendJson(
          createEnvelope({
            type: 'tts.end',
            sessionId,
            requestId,
            payload: { text: fullText },
          }),
        );
        sendJson(
          createEnvelope({
            type: 'agent.done',
            sessionId,
            requestId,
            payload: { text: fullText },
          }),
        );
      } catch (error) {
        if (error instanceof ElevenLabsAbortError || task.controller.signal.aborted) {
          // interrupt() already emitted tts.interrupted and persisted the partial reply
          return;
        }
        request.log.error({ err: error, sessionId }, 'voice agent loop failed');
        sendJson(
          createEnvelope({
            type: 'voice.error',
            sessionId,
            requestId,
            payload: {
              error: error instanceof Error ? error.message : 'Internal error',
            },
          }),
        );
      } finally {
        if (activeTask === task) activeTask = undefined;
      }
    };

    void deps.store
      .getSession(sessionId)
      .then(async () => {
        if (!voice.stt.configured || !voice.tts.configured) {
          sendJson(
            createEnvelope({
              type: 'voice.error',
              sessionId,
              requestId: connectionId,
              payload: { error: 'ElevenLabs is not configured' },
            }),
          );
          socket.close();
          return;
        }

        voice.stt.onTranscript((event) => {
          if (event.isFinal) {
            sendJson(
              createEnvelope({
                type: 'transcript.final',
                sessionId,
                requestId: connectionId,
                payload: { text: event.text },
              }),
            );
            const text = event.text.trim();
            // 先等打断的部分回复落库，再开新一轮：否则新一轮的 user 消息可能
            // 先入库，历史里出现"助手先答后问"。
            const pending = activeTask ? interrupt('new_final_transcript') : Promise.resolve();
            void pending.then(() => (text ? runVoiceTask(event.text) : undefined));
            return;
          }

          sendJson(
            createEnvelope({
              type: 'transcript.partial',
              sessionId,
              requestId: connectionId,
              payload: { text: event.text },
            }),
          );
          // Barge-in: the user started speaking while the agent was talking.
          if (event.text.trim().length > 0 && activeTask) {
            void interrupt('user_speech');
          }
        });

        voice.stt.onError?.((error) => {
          request.log.error({ err: error, sessionId }, 'STT error');
          sendJson(
            createEnvelope({
              type: 'voice.error',
              sessionId,
              requestId: connectionId,
              payload: { error: error.message },
            }),
          );
        });

        socket.on('message', (data, isBinary) => {
          if (isBinary) {
            void voice.stt.sendAudio(Buffer.from(data as Buffer)).catch((error) => {
              request.log.error({ err: error, sessionId }, 'STT sendAudio failed');
              sendJson(
                createEnvelope({
                  type: 'voice.error',
                  sessionId,
                  requestId: connectionId,
                  payload: { error: 'STT 会话不可用，请重新唤醒' },
                }),
              );
              socket.close();
            });
            return;
          }
          try {
            const message = JSON.parse(data.toString()) as { type?: string };
            if (message.type === 'end') {
              void voice.stt.stop();
            } else if (message.type === 'interrupt') {
              void interrupt('client');
            } else if (message.type === 'permission.response') {
              const payload = message as {
                requestId?: string;
                approved?: boolean;
                reason?: string;
              };
              if (payload.requestId && typeof payload.approved === 'boolean') {
                // 归属校验：本连接只能答复自己会话的请求（N-P0-3）。
                deps.approvals.respond(
                  payload.requestId,
                  {
                    approved: payload.approved,
                    ...(payload.reason ? { reason: payload.reason } : {}),
                  },
                  sessionId,
                );
              }
            }
          } catch {
            // ignore malformed control messages
          }
        });

        socket.on('close', () => {
          if (activeTask) {
            activeTask.controller.abort();
            activeTask = undefined;
          }
          void voice.stt.stop();
        });

        try {
          await voice.stt.start();
          sendJson(
            createEnvelope({
              type: 'voice.ready',
              sessionId,
              requestId: connectionId,
              payload: { audioFormat: voice.stt.audioFormat },
            }),
          );
        } catch (error) {
          request.log.error({ err: error, sessionId }, 'failed to start STT');
          sendJson(
            createEnvelope({
              type: 'voice.error',
              sessionId,
              requestId: connectionId,
              payload: { error: error instanceof Error ? error.message : 'STT failed' },
            }),
          );
          socket.close();
        }
      })
      .catch((error) => {
        request.log.error({ err: error, sessionId }, 'voice session lookup failed');
        sendJson(
          createEnvelope({
            type: 'voice.error',
            sessionId,
            requestId: connectionId,
            payload: { error: 'Session not found' },
          }),
        );
        socket.close();
      });
  });
}
