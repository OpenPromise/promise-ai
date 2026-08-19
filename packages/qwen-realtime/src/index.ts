import WebSocket from 'ws';

// ---------------------------------------------------------------- types

export type QwenTurnDetection =
  | { type: 'server_vad'; threshold?: number; silence_duration_ms?: number }
  | { type: 'smart_turn'; threshold?: number; silence_duration_ms?: number }
  | null;

export interface QwenToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** Fields for the `session` object of a `session.update` client event. */
export interface QwenRealtimeSession {
  modalities?: Array<'text' | 'audio'>;
  voice?: string;
  instructions?: string;
  input_audio_format?: 'pcm';
  /** Qwen-ASR: recognition language (e.g. `zh`, `en`) and optional context. */
  input_audio_transcription?: { language?: string; context?: string };
  output_audio_format?: 'pcm';
  /** Qwen-TTS: `server_commit` (server segments text) or `commit` (client controls). */
  mode?: 'server_commit' | 'commit';
  language_type?: string;
  response_format?: 'pcm' | 'wav' | 'mp3' | 'opus';
  sample_rate?: number;
  max_history_turns?: number;
  tools?: QwenToolDefinition[];
  turn_detection?: QwenTurnDetection;
}

export type QwenTranscriptKind = 'partial' | 'final';

export interface QwenTranscriptEvent {
  kind: QwenTranscriptKind;
  text: string;
}

export interface QwenAudioChunkEvent {
  data: Buffer;
  /** Wire format label, e.g. `pcm` (24 kHz mono 16-bit output). */
  format: string;
  sampleRate: number;
}

export interface QwenFunctionCallEvent {
  callId: string;
  name: string;
  arguments: string;
  /** Response that carried this call; lets callers ignore its late `done`. */
  responseId?: string;
}

export type QwenResponseStatus = 'completed' | 'cancelled' | 'failed' | 'in_progress';

export interface QwenResponseDoneEvent {
  id?: string;
  status: QwenResponseStatus;
  /** Full assistant text accumulated across audio_transcript deltas. */
  text: string;
}

export type QwenTranscriptHandler = (event: QwenTranscriptEvent) => void;
export type QwenAssistantTranscriptHandler = (delta: string) => void;
export type QwenAudioDeltaHandler = (event: QwenAudioChunkEvent) => void;
export type QwenResponseHandler = (event: { id?: string }) => void;
export type QwenResponseDoneHandler = (event: QwenResponseDoneEvent) => void;
export type QwenSpeechHandler = (event: { itemId?: string; invalid?: boolean }) => void;
export type QwenFunctionCallHandler = (event: QwenFunctionCallEvent) => void;
export type QwenSessionFinishedHandler = () => void;
export type QwenErrorHandler = (error: Error) => void;
export type QwenCloseHandler = (code: number, reason: string) => void;

export interface QwenRealtimeOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  createWebSocket?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  /** How long start()/updateSession() wait for the server ack before failing. */
  handshakeTimeoutMs?: number;
}

// ---------------------------------------------------------------- errors

export class QwenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QwenConfigError';
  }
}

export class QwenApiError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'QwenApiError';
    this.code = code;
  }
}

export class QwenHandshakeTimeoutError extends Error {
  constructor(message = 'Qwen realtime handshake timed out') {
    super(message);
    this.name = 'QwenHandshakeTimeoutError';
  }
}

// ---------------------------------------------------------------- client

/**
 * Minimal WebSocket client for the Qwen-Audio-Realtime protocol
 * (`wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=...`).
 *
 * The protocol is OpenAI-realtime style: the client streams 16 kHz PCM audio
 * via `input_audio_buffer.append`, the server runs VAD and replies with
 * streaming transcripts and 24 kHz PCM audio chunks plus function calls.
 */
export class QwenRealtimeClient {
  readonly configured: boolean;
  readonly model: string;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #handshakeTimeoutMs: number;
  readonly #createWebSocket: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  #ws: WebSocket | undefined;

  readonly #transcriptHandlers: QwenTranscriptHandler[] = [];
  readonly #assistantHandlers: QwenAssistantTranscriptHandler[] = [];
  readonly #audioHandlers: QwenAudioDeltaHandler[] = [];
  readonly #responseCreatedHandlers: QwenResponseHandler[] = [];
  readonly #responseDoneHandlers: QwenResponseDoneHandler[] = [];
  readonly #speechHandlers: QwenSpeechHandler[] = [];
  readonly #functionCallHandlers: QwenFunctionCallHandler[] = [];
  readonly #sessionFinishedHandlers: QwenSessionFinishedHandler[] = [];
  readonly #errorHandlers: QwenErrorHandler[] = [];
  readonly #closeHandlers: QwenCloseHandler[] = [];

  #startResolve: (() => void) | undefined;
  #startReject: ((error: Error) => void) | undefined;
  #updateResolve: (() => void) | undefined;
  #updateReject: ((error: Error) => void) | undefined;
  /** Assistant text accumulated per response id (response.audio_transcript.delta). */
  readonly #responseText = new Map<string, string>();
  /** Function calls already emitted per response id, to dedupe fallback events. */
  readonly #emittedCalls = new Set<string>();
  /** Output PCM sample rate, set from the last `session.update`. */
  #outputSampleRate = 24_000;

  constructor(options: QwenRealtimeOptions = {}) {
    this.#apiKey = options.apiKey?.trim() || undefined;
    this.configured = Boolean(this.#apiKey);
    this.model = options.model?.trim() || 'qwen-audio-3.0-realtime-flash';
    this.#baseUrl = (
      options.baseUrl?.trim() || 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
    ).replace(/\/+$/, '');
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;
    this.#createWebSocket = options.createWebSocket ?? ((url, opts) => new WebSocket(url, opts));
  }

  async start(): Promise<void> {
    if (this.#ws) return;
    if (!this.#apiKey) {
      throw new QwenConfigError('DASHSCOPE_API_KEY is not configured');
    }

    const url = new URL(this.#baseUrl);
    url.searchParams.set('model', this.model);

    const ws = this.#createWebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${this.#apiKey}` },
    });
    this.#ws = ws;
    ws.on('message', (data) => this.#handleMessage(data));
    ws.on('error', (error) =>
      this.#emitError(error instanceof Error ? error : new Error(String(error))),
    );
    ws.on('close', (code, reason) => {
      for (const handler of this.#closeHandlers) handler(code, reason.toString());
      this.#rejectPending(new QwenApiError(`Qwen realtime connection closed (${code})`));
    });

    await new Promise<void>((resolve, reject) => {
      // Reject the handshake immediately when the connection fails (e.g. a
      // 401 from an invalid API key) instead of waiting for the timeout.
      ws.once('error', (error) => {
        this.#startReject?.(error instanceof Error ? error : new Error(String(error)));
      });
      ws.once('close', (code, reason) => {
        this.#startReject?.(
          new QwenApiError(`Qwen realtime closed before session.created (${code} ${reason})`),
        );
      });
      const timer = setTimeout(() => {
        this.#startReject?.(new QwenHandshakeTimeoutError());
        this.#startResolve = undefined;
        this.#startReject = undefined;
        reject(new QwenHandshakeTimeoutError());
      }, this.#handshakeTimeoutMs);
      timer.unref?.();
      this.#startResolve = () => {
        clearTimeout(timer);
        this.#startResolve = undefined;
        this.#startReject = undefined;
        resolve();
      };
      this.#startReject = (error) => {
        clearTimeout(timer);
        this.#startResolve = undefined;
        this.#startReject = undefined;
        reject(error);
      };
    });
  }

  /** Sends `session.update` and resolves once `session.updated` is acked. */
  async updateSession(session: QwenRealtimeSession): Promise<void> {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new QwenApiError('Qwen realtime session is not open');
    }

    if (session.sample_rate && session.sample_rate > 0) {
      this.#outputSampleRate = session.sample_rate;
    }
    this.#ws.send(JSON.stringify({ type: 'session.update', session }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#updateReject?.(new QwenHandshakeTimeoutError('Qwen session.update timed out'));
        this.#updateResolve = undefined;
        this.#updateReject = undefined;
        reject(new QwenHandshakeTimeoutError('Qwen session.update timed out'));
      }, this.#handshakeTimeoutMs);
      timer.unref?.();
      this.#updateResolve = () => {
        clearTimeout(timer);
        this.#updateResolve = undefined;
        this.#updateReject = undefined;
        resolve();
      };
      this.#updateReject = (error) => {
        clearTimeout(timer);
        this.#updateResolve = undefined;
        this.#updateReject = undefined;
        reject(error);
      };
    });
  }

  /** Streams a 16 kHz PCM mono 16-bit chunk into the input buffer. */
  sendAudio(chunk: Buffer): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new QwenApiError('Qwen realtime session is not open');
    }
    ws.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: chunk.toString('base64'),
      }),
    );
  }

  /** Commits the input buffer (push-to-talk mode; ignored in VAD modes). */
  commitAudio(): void {
    this.#send({ type: 'input_audio_buffer.commit' });
  }

  /** Manually triggers inference (used after returning function_call_output). */
  createResponse(): void {
    this.#send({ type: 'response.create' });
  }

  /** Cancels the in-flight response (client-side barge-in). */
  cancelResponse(): void {
    this.#send({ type: 'response.cancel' });
  }

  /** Qwen-TTS: append text to the synthesis buffer. */
  appendText(text: string): void {
    this.#send({ type: 'input_text_buffer.append', text });
  }

  /** Qwen-TTS: commit buffered text and synthesize immediately. */
  commitText(): void {
    this.#send({ type: 'input_text_buffer.commit' });
  }

  /** Qwen-TTS: discard buffered text (commit mode only). */
  clearText(): void {
    this.#send({ type: 'input_text_buffer.clear' });
  }

  /** Qwen-ASR/TTS: tell the server no more input follows; it flushes remaining results. */
  finishSession(): void {
    this.#send({ type: 'session.finish' });
  }

  /** Returns a tool result so the model can continue its second inference round. */
  sendFunctionCallOutput(callId: string, output: string): void {
    this.#send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
      },
    });
  }

  close(): void {
    const ws = this.#ws;
    this.#ws = undefined;
    if (!ws) return;
    ws.removeAllListeners();
    // keep a no-op error listener so a close-time error cannot crash the process
    ws.on('error', () => {});
    ws.close();
  }

  // ---------------------------------------------------------------- events

  onTranscript(handler: QwenTranscriptHandler): void {
    this.#transcriptHandlers.push(handler);
  }

  onAssistantTranscript(handler: QwenAssistantTranscriptHandler): void {
    this.#assistantHandlers.push(handler);
  }

  onAudioDelta(handler: QwenAudioDeltaHandler): void {
    this.#audioHandlers.push(handler);
  }

  onResponseCreated(handler: QwenResponseHandler): void {
    this.#responseCreatedHandlers.push(handler);
  }

  onResponseDone(handler: QwenResponseDoneHandler): void {
    this.#responseDoneHandlers.push(handler);
  }

  onSpeechStarted(handler: QwenSpeechHandler): void {
    this.#speechHandlers.push((event) => {
      if (!event.invalid) handler(event);
    });
  }

  onSpeechStopped(handler: QwenSpeechHandler): void {
    this.#speechHandlers.push(handler);
  }

  onFunctionCall(handler: QwenFunctionCallHandler): void {
    this.#functionCallHandlers.push(handler);
  }

  onSessionFinished(handler: QwenSessionFinishedHandler): void {
    this.#sessionFinishedHandlers.push(handler);
  }

  onError(handler: QwenErrorHandler): void {
    this.#errorHandlers.push(handler);
  }

  onClose(handler: QwenCloseHandler): void {
    this.#closeHandlers.push(handler);
  }

  // ---------------------------------------------------------------- internals

  #send(payload: Record<string, unknown>): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new QwenApiError('Qwen realtime session is not open');
    }
    ws.send(JSON.stringify(payload));
  }

  #handleMessage(raw: WebSocket.RawData): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof message.type === 'string' ? message.type : '';
    switch (type) {
      case 'session.created':
        this.#startResolve?.();
        break;
      case 'session.updated':
        this.#updateResolve?.();
        break;
      case 'error': {
        const error = message.error as { message?: string; code?: string } | undefined;
        const text = error?.message ?? 'Qwen realtime API error';
        const qwenError = new QwenApiError(text, error?.code);
        this.#emitError(qwenError);
        this.#startReject?.(qwenError);
        this.#updateReject?.(qwenError);
        break;
      }
      case 'input_audio_buffer.speech_started':
        for (const handler of this.#speechHandlers) handler({});
        break;
      case 'input_audio_buffer.speech_stopped': {
        const payload = message as { item_id?: string; reason?: string };
        for (const handler of this.#speechHandlers) {
          handler({
            itemId: payload.item_id,
            invalid: payload.reason === 'turn_invalid',
          });
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.delta':
      case 'conversation.item.input_audio_transcription.text': {
        const payload = message as { text?: string; stash?: string };
        const text = `${payload.text ?? ''}${payload.stash ?? ''}`.trim();
        if (!text) break;
        for (const handler of this.#transcriptHandlers) {
          handler({ kind: 'partial', text });
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const payload = message as { transcript?: string };
        const text = (payload.transcript ?? '').trim();
        if (!text) break;
        for (const handler of this.#transcriptHandlers) {
          handler({ kind: 'final', text });
        }
        break;
      }
      case 'response.created': {
        const payload = message as { response?: { id?: string } };
        const id = payload.response?.id;
        if (id) this.#responseText.set(id, '');
        for (const handler of this.#responseCreatedHandlers) {
          handler({ id });
        }
        break;
      }
      case 'response.audio_transcript.delta': {
        const payload = message as { response_id?: string; delta?: string };
        const delta = payload.delta ?? '';
        const responseId = payload.response_id;
        if (responseId) {
          this.#responseText.set(responseId, `${this.#responseText.get(responseId) ?? ''}${delta}`);
        }
        if (!delta) break;
        for (const handler of this.#assistantHandlers) handler(delta);
        break;
      }
      case 'response.audio.delta': {
        const payload = message as { delta?: string };
        if (typeof payload.delta !== 'string' || !payload.delta) break;
        for (const handler of this.#audioHandlers) {
          handler({
            data: Buffer.from(payload.delta, 'base64'),
            format: 'pcm',
            sampleRate: this.#outputSampleRate,
          });
        }
        break;
      }
      case 'session.finished':
        for (const handler of this.#sessionFinishedHandlers) handler();
        break;
      case 'response.function_call_arguments.done': {
        const payload = message as {
          response_id?: string;
          call_id?: string;
          name?: string;
          arguments?: string;
        };
        const callId = payload.call_id ?? '';
        const name = payload.name ?? '';
        const argumentsText = payload.arguments ?? '{}';
        if (callId && name && !this.#emittedCalls.has(callId)) {
          this.#emittedCalls.add(callId);
          for (const handler of this.#functionCallHandlers) {
            handler({ callId, name, arguments: argumentsText, responseId: payload.response_id });
          }
        }
        break;
      }
      case 'response.output_item.done': {
        const item = message.item as
          | {
              type?: string;
              call_id?: string;
              name?: string;
              arguments?: string;
            }
          | undefined;
        if (item?.type === 'function_call' && item.call_id && item.name) {
          if (!this.#emittedCalls.has(item.call_id)) {
            this.#emittedCalls.add(item.call_id);
            for (const handler of this.#functionCallHandlers) {
              handler({
                callId: item.call_id,
                name: item.name,
                arguments: item.arguments ?? '{}',
                responseId: (message as { response_id?: string }).response_id,
              });
            }
          }
        }
        break;
      }
      case 'response.done': {
        const payload = message as { response?: { id?: string; status?: string } };
        const responseId = payload.response?.id;
        const text = responseId ? (this.#responseText.get(responseId) ?? '') : '';
        if (responseId) this.#responseText.delete(responseId);
        for (const handler of this.#responseDoneHandlers) {
          handler({
            id: responseId,
            status: (payload.response?.status ?? 'completed') as QwenResponseStatus,
            text,
          });
        }
        break;
      }
    }
  }

  #emitError(error: Error): void {
    for (const handler of this.#errorHandlers) handler(error);
  }

  #rejectPending(error: Error): void {
    this.#startReject?.(error);
    this.#updateReject?.(error);
    this.#startResolve = undefined;
    this.#startReject = undefined;
    this.#updateResolve = undefined;
    this.#updateReject = undefined;
  }
}
