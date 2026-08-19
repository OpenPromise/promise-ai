export const PROTOCOL_VERSION = '1.0' as const;

export interface ProtocolEnvelope<T = unknown> {
  type: string;
  timestamp: string;
  sessionId: string;
  requestId: string;
  deviceId?: string;
  payload: T;
}

export interface CreateEnvelopeInput<T> {
  type: string;
  sessionId: string;
  requestId?: string;
  deviceId?: string;
  payload: T;
}

function defaultRequestId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createEnvelope<T>(input: CreateEnvelopeInput<T>): ProtocolEnvelope<T> {
  return {
    type: input.type,
    timestamp: new Date().toISOString(),
    sessionId: input.sessionId,
    requestId: input.requestId ?? defaultRequestId(),
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    payload: input.payload,
  };
}

export const EventNames = {
  USER_SPEECH_START: 'USER_SPEECH_START',
  USER_SPEECH_END: 'USER_SPEECH_END',
  TRANSCRIPT_PARTIAL: 'TRANSCRIPT_PARTIAL',
  TRANSCRIPT_FINAL: 'TRANSCRIPT_FINAL',
  AGENT_THINKING: 'AGENT_THINKING',
  TOOL_CALL: 'TOOL_CALL',
  TOOL_RESULT: 'TOOL_RESULT',
  TTS_START: 'TTS_START',
  TTS_CHUNK: 'TTS_CHUNK',
  TTS_END: 'TTS_END',
  SESSION_START: 'SESSION_START',
  SESSION_END: 'SESSION_END',
  TASK_CREATED: 'TASK_CREATED',
  TASK_COMPLETED: 'TASK_COMPLETED',
  DEVICE_CONNECTED: 'DEVICE_CONNECTED',
  DEVICE_DISCONNECTED: 'DEVICE_DISCONNECTED',
} as const;

export type EventName = (typeof EventNames)[keyof typeof EventNames];

export const ChatEventTypes = {
  TOKEN: 'chat.token',
  DONE: 'chat.done',
  ERROR: 'chat.error',
} as const;

export type ChatEventType = (typeof ChatEventTypes)[keyof typeof ChatEventTypes];
