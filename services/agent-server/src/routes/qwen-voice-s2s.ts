import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { QwenRealtimeClient, type QwenFunctionCallEvent } from '@personal-ai/qwen-realtime';
import type { SessionStore } from '@personal-ai/memory';
import { createEnvelope } from '@personal-ai/protocol';
import type { ToolCallInfo } from '@personal-ai/types';
import type { ToolContext, ToolRegistry, ToolResult } from '@personal-ai/tools';
import { randomUUID } from 'node:crypto';
import type { ApprovalRegistry } from '../services/approval.js';
import { runToolCallWithApproval } from '../services/tool-execution.js';
import type { ConversationService } from '../services/conversation.js';

interface VoiceParams {
  sessionId: string;
}

export interface QwenS2SVoiceRouteDeps {
  store: SessionStore;
  tools: ToolRegistry;
  approvals: ApprovalRegistry;
  /** 文本推理代理：语音委托子代理（voice.delegate）用它执行复杂任务。 */
  conversation: ConversationService;
  /** S2S speaker voice (e.g. `longanqian`). */
  voice: string;
  createQwen: () => QwenRealtimeClient;
}

/** 委托子代理的最大运行时长（分钟）：超时中止并返回错误，避免语音回合无限等待。 */
const DELEGATE_TIMEOUT_MS = 20 * 60 * 1000;

const VOICE_RULES =
  '## 语音交互规则\n' +
  '- 当用户要求执行实际操作（打开文件/文件夹/程序、移动、复制、删除等）时，' +
  '必须调用对应工具；工具执行成功后才能告诉用户结果，不能凭空确认。\n' +
  '- 执行完工具后的确认要极简，一两个词即可，例如"打开了"；不要复述过程。\n' +
  '- 复杂、多步骤或耗时的任务（如用编程代理写代码、连续完成多个操作、需要仔细推理）' +
  '优先调用 voice.delegate 并给出清晰任务描述；简单单步操作直接用对应工具。\n' +
  '- 日常回答同样简短自然，一次只说一两句。';

/**
 * Voice WebSocket backed by the Qwen end-to-end speech-to-speech model
 * (`qwen-audio-3.0-realtime-plus`): the desktop streams 16 kHz PCM, the model
 * runs VAD + reasoning + synthesis on one realtime WebSocket, and the server
 * forwards back 24 kHz PCM plus streaming transcripts. Function calls bridge
 * to the local ToolRegistry + ApprovalRegistry, then the result is fed back
 * into the model for the next inference round.
 */
export function registerQwenS2SVoiceRoutes(
  app: FastifyInstance,
  deps: QwenS2SVoiceRouteDeps,
): void {
  app.get('/ws/voice/:sessionId', { websocket: true }, (socket, request) => {
    const { sessionId } = (request.params ?? {}) as VoiceParams;
    const requestId = randomUUID();
    const sendJson = (payload: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    };
    let closed = false;

    void deps.store
      .getSession(sessionId)
      .then(async (session) => {
        const qwen = deps.createQwen();
        const toolContext: ToolContext = { sessionId, requestId };
        let toolRunning = false;
        // True from the moment the model emits a function call until its
        // result has been fed back and the follow-up response was requested.
        let toolPending = false;
        let audioStarted = false;
        // Response ids that carried a function call. Their `response.done`
        // may arrive at any time (even after the tool executed), and must
        // never be treated as the final reply.
        const toolResponseIds = new Set<string>();

        // User turns: stream partial transcripts, persist the final one.
        qwen.onTranscript((event) => {
          if (event.kind === 'partial') {
            sendJson(
              createEnvelope({
                type: 'transcript.partial',
                sessionId,
                requestId,
                payload: { text: event.text },
              }),
            );
            return;
          }
          sendJson(
            createEnvelope({
              type: 'transcript.final',
              sessionId,
              requestId,
              payload: { text: event.text },
            }),
          );
          const text = event.text.trim();
          if (text) {
            void deps.store
              .addMessage(sessionId, { role: 'user', content: text })
              .catch((error) => {
                request.log.error({ err: error, sessionId }, 'failed to persist user transcript');
              });
          }
        });

        // Assistant reply: stream the transcript and forward PCM audio as-is.
        qwen.onAssistantTranscript((delta) => {
          if (!delta) return;
          sendJson(
            createEnvelope({
              type: 'transcript.partial',
              sessionId,
              requestId,
              payload: { text: delta, role: 'assistant' },
            }),
          );
        });

        qwen.onAudioDelta((event) => {
          if (!audioStarted) {
            audioStarted = true;
            sendJson(
              createEnvelope({
                type: 'agent.state',
                sessionId,
                requestId,
                payload: { state: 'speaking' },
              }),
            );
          }
          sendJson({
            type: 'audio.chunk',
            timestamp: new Date().toISOString(),
            sessionId,
            requestId,
            payload: {
              data: event.data.toString('base64'),
              format: event.format,
              sampleRate: event.sampleRate,
            },
          });
        });

        qwen.onResponseCreated(() => {
          // A new response after a tool round resolves the pending call.
          toolPending = false;
          audioStarted = false;
          sendJson(
            createEnvelope({
              type: 'agent.thinking',
              sessionId,
              requestId,
              payload: {},
            }),
          );
          sendJson(
            createEnvelope({
              type: 'agent.state',
              sessionId,
              requestId,
              payload: { state: 'thinking' },
            }),
          );
        });

        qwen.onResponseDone((event) => {
          const text = event.text.trim();
          // A response that only carried a function call is not the final
          // reply: the tool still has to run and the model then produces a
          // second response. Ending the turn here closes the voice session on
          // the desktop before the tool result can be fed back, hanging the
          // conversation.
          if ((event.id && toolResponseIds.delete(event.id)) || toolPending) return;
          if (event.status === 'completed') {
            if (text) {
              void deps.store
                .addMessage(sessionId, { role: 'assistant', content: text })
                .catch((error) => {
                  request.log.error({ err: error, sessionId }, 'failed to persist assistant reply');
                });
            }
            sendJson(
              createEnvelope({
                type: 'tts.end',
                sessionId,
                requestId,
                payload: { text },
              }),
            );
            sendJson(
              createEnvelope({
                type: 'agent.done',
                sessionId,
                requestId,
                payload: { text },
              }),
            );
            sendJson(
              createEnvelope({
                type: 'agent.state',
                sessionId,
                requestId,
                payload: { state: 'listening' },
              }),
            );
          } else if (event.status === 'cancelled') {
            // Barge-in: keep the partial reply for context, clear playback.
            if (text) {
              void deps.store
                .addMessage(sessionId, { role: 'assistant', content: text })
                .catch((error) => {
                  request.log.error({ err: error, sessionId }, 'failed to persist partial reply');
                });
            }
            sendJson(
              createEnvelope({
                type: 'tts.interrupted',
                sessionId,
                requestId,
                payload: { reason: 'barge_in' },
              }),
            );
            sendJson(
              createEnvelope({
                type: 'agent.state',
                sessionId,
                requestId,
                payload: { state: 'listening' },
              }),
            );
          } else {
            sendJson(
              createEnvelope({
                type: 'voice.error',
                sessionId,
                requestId,
                payload: { error: `Qwen response failed (${event.status})` },
              }),
            );
          }
        });

        // The user started speaking while the model was talking: stop playback.
        qwen.onSpeechStarted(() => {
          sendJson(
            createEnvelope({
              type: 'tts.interrupted',
              sessionId,
              requestId,
              payload: { reason: 'user_speech' },
            }),
          );
          sendJson(
            createEnvelope({
              type: 'agent.state',
              sessionId,
              requestId,
              payload: { state: 'listening' },
            }),
          );
        });

        qwen.onFunctionCall((call) => {
          if (toolRunning) return;
          toolRunning = true;
          toolPending = true;
          if (call.responseId) toolResponseIds.add(call.responseId);
          void runFunctionCall(qwen, call).finally(() => {
            toolRunning = false;
          });
        });

        qwen.onError((error) => {
          // 打断时服务端可能报 "Conversation has no active response"——
          // 这是无害的取消错误，不应因此断开整个语音会话。
          const message = error.message ?? '';
          if (
            (error as { code?: string }).code === 'invalid_value' &&
            /no active response/i.test(message)
          ) {
            request.log.debug({ sessionId }, 'qwen ignored benign cancel error');
            return;
          }
          request.log.error({ err: error, sessionId }, 'qwen realtime error');
          sendJson(
            createEnvelope({
              type: 'voice.error',
              sessionId,
              requestId,
              payload: { error: error.message },
            }),
          );
        });

        qwen.onClose((code, reason) => {
          if (closed) return;
          closed = true;
          request.log.warn({ code, reason, sessionId }, 'qwen realtime closed');
          sendJson(
            createEnvelope({
              type: 'voice.error',
              sessionId,
              requestId,
              payload: { error: '语音服务连接已断开' },
            }),
          );
          socket.close();
        });

        try {
          await qwen.start();
          await qwen.updateSession({
            modalities: ['text', 'audio'],
            voice: deps.voice,
            instructions: session.systemPrompt
              ? `${session.systemPrompt}\n\n${VOICE_RULES}`
              : VOICE_RULES,
            turn_detection: { type: 'smart_turn', silence_duration_ms: 250 },
            tools: toQwenTools(deps.tools),
          });
          sendJson(
            createEnvelope({
              type: 'voice.ready',
              sessionId,
              requestId,
              payload: { audioFormat: 'pcm_16000', outputFormat: 'pcm_24000' },
            }),
          );
        } catch (error) {
          request.log.error({ err: error, sessionId }, 'failed to start qwen realtime');
          sendJson(
            createEnvelope({
              type: 'voice.error',
              sessionId,
              requestId,
              payload: {
                error: error instanceof Error ? error.message : 'Qwen realtime 启动失败',
              },
            }),
          );
          socket.close();
          return;
        }

        socket.on('message', (data, isBinary) => {
          if (isBinary) {
            try {
              qwen.sendAudio(Buffer.from(data as Buffer));
            } catch (error) {
              request.log.error({ err: error, sessionId }, 'qwen sendAudio failed');
              sendJson(
                createEnvelope({
                  type: 'voice.error',
                  sessionId,
                  requestId,
                  payload: { error: '语音会话不可用，请重新唤醒' },
                }),
              );
              socket.close();
            }
            return;
          }
          try {
            const message = JSON.parse(data.toString()) as { type?: string };
            if (message.type === 'end') {
              // smart_turn 模式由服务端自动判断回合结束，无需手动提交。
            } else if (message.type === 'interrupt') {
              qwen.cancelResponse();
              sendJson(
                createEnvelope({
                  type: 'tts.interrupted',
                  sessionId,
                  requestId,
                  payload: { reason: 'client' },
                }),
              );
            } else if (message.type === 'permission.response') {
              const payload = message as {
                requestId?: string;
                approved?: boolean;
                reason?: string;
              };
              if (payload.requestId && typeof payload.approved === 'boolean') {
                deps.approvals.respond(payload.requestId, {
                  approved: payload.approved,
                  ...(payload.reason ? { reason: payload.reason } : {}),
                });
              }
            }
          } catch {
            // ignore malformed control messages
          }
        });

        socket.on('close', () => {
          closed = true;
          qwen.close();
        });

        async function runFunctionCall(
          qwen: QwenRealtimeClient,
          call: QwenFunctionCallEvent,
        ): Promise<void> {
          try {
            sendJson(
              createEnvelope({
                type: 'agent.tool_call',
                sessionId,
                requestId,
                payload: { toolCalls: [call] },
              }),
            );

            // voice.delegate（OpenDex run_task 模式）：把复杂任务交给文本推理代理
            // 执行，代理拥有全部工具（含桌面桥），完成后只把结果摘要回给语音模型。
            if (call.name === 'voice.delegate') {
              let task = '';
              try {
                const parsed = JSON.parse(call.arguments) as { task?: unknown };
                if (typeof parsed.task === 'string') task = parsed.task.trim();
              } catch {
                // fall through to the missing-task error below
              }
              if (!task) {
                qwen.sendFunctionCallOutput(
                  call.callId,
                  JSON.stringify({ ok: false, error: 'voice.delegate 缺少 task 参数' }),
                );
                qwen.createResponse();
                return;
              }

              let summary = '';
              const controller = new AbortController();
              const delegateTimer = setTimeout(
                () => controller.abort(new Error('委托任务执行超时（20 分钟）')),
                DELEGATE_TIMEOUT_MS,
              );
              delegateTimer.unref?.();
              try {
                for await (const envelope of deps.conversation.runChat({
                  sessionId,
                  userMessage: task,
                  signal: controller.signal,
                })) {
                  // 转发状态/审批/工具进度给桌面 UI；语音模型只等最终结果。
                  sendJson(envelope);
                  if (envelope.type === 'chat.done') {
                    const text = (envelope.payload as { text?: string }).text ?? '';
                    if (text) summary = text;
                  }
                }
              } catch (error) {
                summary = `委托任务失败：${error instanceof Error ? error.message : String(error)}`;
              } finally {
                clearTimeout(delegateTimer);
              }

              const result: ToolResult = summary
                ? { ok: true, data: { summary, delegated: true } }
                : { ok: false, error: '委托任务未返回结果' };
              sendJson(
                createEnvelope({
                  type: 'agent.tool_result',
                  sessionId,
                  requestId,
                  payload: { callId: call.callId, name: call.name, result },
                }),
              );
              qwen.sendFunctionCallOutput(call.callId, JSON.stringify(result));
              qwen.createResponse();
              return;
            }

            const iterator = runToolCallWithApproval(
              deps.approvals,
              deps.tools,
              toToolCallInfo(call),
              toolContext,
              false,
            );
            let result: ToolResult | undefined;
            while (true) {
              const next = await iterator.next();
              if (next.done) {
                result = next.value;
                break;
              }
              sendJson(next.value);
            }
            if (result === undefined) {
              result = { ok: false, error: `工具 ${call.name} 执行异常` };
            }

            sendJson(
              createEnvelope({
                type: 'agent.tool_result',
                sessionId,
                requestId,
                payload: { callId: call.callId, name: call.name, result },
              }),
            );

            qwen.sendFunctionCallOutput(call.callId, JSON.stringify(result));
            qwen.createResponse();
          } catch (error) {
            request.log.error({ err: error, sessionId, tool: call.name }, 'qwen tool call failed');
            sendJson(
              createEnvelope({
                type: 'voice.error',
                sessionId,
                requestId,
                payload: {
                  error: error instanceof Error ? error.message : '工具执行失败',
                },
              }),
            );
          }
        }
      })
      .catch((error) => {
        request.log.error({ err: error, sessionId }, 'qwen voice session lookup failed');
        sendJson(
          createEnvelope({
            type: 'voice.error',
            sessionId,
            requestId,
            payload: { error: 'Session not found' },
          }),
        );
        socket.close();
      });
  });
}

function toQwenTools(registry: ToolRegistry): Array<{
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}> {
  return [
    {
      type: 'function' as const,
      function: {
        name: 'voice.delegate',
        description:
          '把复杂、多步骤或耗时的任务交给文本推理代理执行（可调用屏幕、终端、文件、编程等全部工具），完成后返回结果摘要。适合一次完成多个操作或需要仔细推理的任务。',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: '要执行的任务描述，越具体越好' },
          },
          required: ['task'],
        },
      },
    },
    ...registry.list().map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    })),
  ];
}

function toToolCallInfo(call: QwenFunctionCallEvent): ToolCallInfo {
  return {
    id: call.callId,
    name: call.name,
    arguments: call.arguments,
  };
}
