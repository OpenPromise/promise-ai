import WebSocket from 'ws';

export type TranscriptKind = 'partial' | 'final';

export interface TranscriptEvent {
  kind: TranscriptKind;
  text: string;
  isFinal: boolean;
}

export type TranscriptHandler = (event: TranscriptEvent) => void;
export type ErrorHandler = (error: Error) => void;

export interface STTProvider {
  readonly configured: boolean;
  readonly audioFormat?: string;
  start(): Promise<void>;
  sendAudio(chunk: Buffer): Promise<void>;
  onTranscript(handler: TranscriptHandler): void;
  onError?(handler: ErrorHandler): void;
  stop(): Promise<void>;
}

export interface AudioChunk {
  data: Buffer;
  sampleRate?: number;
  format?: string;
}

export interface TTSProvider {
  readonly configured: boolean;
  synthesize(text: string, options?: { signal?: AbortSignal }): AsyncIterable<AudioChunk>;
}

export interface VoiceGateway {
  stt: STTProvider;
  tts: TTSProvider;
}

export class ElevenLabsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElevenLabsConfigError';
  }
}

export class ElevenLabsApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ElevenLabsApiError';
    this.status = status;
  }
}

export class ElevenLabsAbortError extends Error {
  constructor(message = 'ElevenLabs operation aborted') {
    super(message);
    this.name = 'ElevenLabsAbortError';
  }
}

// ---------------------------------------------------------------- TTS

export interface ElevenLabsTTSOptions {
  apiKey?: string;
  voiceId?: string;
  baseUrl?: string;
  modelId?: string;
  languageCode?: string;
  outputFormat?: string;
  voiceSettings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
  };
}

/**
 * Streaming Text-to-Speech via
 * POST /v1/text-to-speech/{voice_id}/stream (audio bytes as response body).
 */
export class ElevenLabsTTS implements TTSProvider {
  readonly configured: boolean;
  readonly voiceId: string;
  readonly modelId: string;
  readonly #languageCode: string | undefined;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #outputFormat: string;
  readonly #voiceSettings: Record<string, unknown>;

  constructor(options: ElevenLabsTTSOptions = {}) {
    this.#apiKey = options.apiKey?.trim() || undefined;
    this.configured = Boolean(this.#apiKey);
    this.voiceId = options.voiceId?.trim() || '';
    this.modelId = options.modelId?.trim() || 'eleven_multilingual_v2';
    this.#languageCode = options.languageCode?.trim() || undefined;
    this.#baseUrl = (options.baseUrl?.trim() || 'https://api.elevenlabs.io').replace(/\/+$/, '');
    this.#outputFormat = options.outputFormat?.trim() || 'mp3_44100_128';
    this.#voiceSettings = options.voiceSettings ?? {
      stability: 0.6,
      similarity_boost: 0.75,
      style: 0.3,
      use_speaker_boost: true,
    };
  }

  async *synthesize(
    text: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<AudioChunk> {
    if (!this.#apiKey) {
      throw new ElevenLabsConfigError('ELEVENLABS_API_KEY is not configured');
    }
    if (!this.voiceId) {
      throw new ElevenLabsConfigError('ELEVENLABS_VOICE_ID is not configured');
    }
    const signal = options.signal;
    if (signal?.aborted) {
      throw new ElevenLabsAbortError();
    }

    const url = new URL(
      `${this.#baseUrl}/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream`,
    );
    url.searchParams.set('output_format', this.#outputFormat);

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': this.#apiKey,
        },
        signal: controller.signal,
        body: JSON.stringify({
          text,
          model_id: this.modelId,
          ...(this.#languageCode ? { language_code: this.#languageCode } : {}),
          voice_settings: this.#voiceSettings,
        }),
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new ElevenLabsAbortError();
      }
      throw new ElevenLabsApiError(
        `ElevenLabs TTS network error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      signal?.removeEventListener('abort', onAbort);
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // ignore body read failure
      }
      throw new ElevenLabsApiError(
        `ElevenLabs TTS error ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
        response.status,
      );
    }
    if (!response.body) {
      throw new ElevenLabsApiError('Empty response body from ElevenLabs TTS');
    }

    const reader = response.body.getReader();
    try {
      while (true) {
        if (signal?.aborted) {
          throw new ElevenLabsAbortError();
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (signal?.aborted) {
          throw new ElevenLabsAbortError();
        }
        yield { data: Buffer.from(value), format: this.#outputFormat.split('_')[0] };
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
  }
}

// ---------------------------------------------------------------- STT

export interface ElevenLabsSTTOptions {
  apiKey?: string;
  baseUrl?: string;
  modelId?: string;
  audioFormat?: string;
  languageCode?: string;
  commitStrategy?: 'vad' | 'manual';
  vadSilenceThresholdSecs?: number;
  createWebSocket?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
}

/**
 * Realtime Speech-to-Text via the ElevenLabs WebSocket API
 * (wss://api.elevenlabs.io/v1/speech-to-text/realtime).
 *
 * Client sends `input_audio_chunk` messages with base64 PCM audio; the server
 * replies with `sessionStarted`, `partialTranscript`, `committedTranscript` /
 * `finalTranscript` and error events.
 */
export class ElevenLabsSTT implements STTProvider {
  readonly configured: boolean;
  readonly audioFormat: string;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #modelId: string;
  readonly #languageCode: string | undefined;
  readonly #commitStrategy: 'vad' | 'manual';
  readonly #vadSilenceThresholdSecs: number | undefined;
  readonly #createWebSocket: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  #ws: WebSocket | undefined;
  readonly #handlers: TranscriptHandler[] = [];
  readonly #errorHandlers: ErrorHandler[] = [];

  constructor(options: ElevenLabsSTTOptions = {}) {
    this.#apiKey = options.apiKey?.trim() || undefined;
    this.configured = Boolean(this.#apiKey);
    this.audioFormat = options.audioFormat?.trim() || 'pcm_16000';
    this.#baseUrl = (options.baseUrl?.trim() || 'wss://api.elevenlabs.io').replace(/\/+$/, '');
    this.#modelId = options.modelId?.trim() || 'scribe_v2_realtime';
    this.#languageCode = options.languageCode?.trim() || undefined;
    this.#commitStrategy = options.commitStrategy ?? 'vad';
    this.#vadSilenceThresholdSecs = options.vadSilenceThresholdSecs;
    this.#createWebSocket = options.createWebSocket ?? ((url, opts) => new WebSocket(url, opts));
  }

  async start(): Promise<void> {
    if (this.#ws) return;
    if (!this.#apiKey) {
      throw new ElevenLabsConfigError('ELEVENLABS_API_KEY is not configured');
    }

    const ws = this.#createWebSocket(this.#buildUrl(), {
      headers: { 'xi-api-key': this.#apiKey },
    });
    this.#ws = ws;
    ws.on('message', (data) => this.#handleMessage(data));
    ws.on('error', (error) =>
      this.#emitError(error instanceof Error ? error : new Error(String(error))),
    );

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
  }

  async sendAudio(chunk: Buffer): Promise<void> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new ElevenLabsConfigError('STT session is not open');
    }
    ws.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: chunk.toString('base64'),
      }),
    );
  }

  onTranscript(handler: TranscriptHandler): void {
    this.#handlers.push(handler);
  }

  onError(handler: ErrorHandler): void {
    this.#errorHandlers.push(handler);
  }

  async stop(): Promise<void> {
    const ws = this.#ws;
    this.#ws = undefined;
    if (!ws) return;
    ws.removeAllListeners();
    // keep a no-op error listener so a close-time error cannot crash the process
    ws.on('error', () => {});
    ws.close();
  }

  #buildUrl(): string {
    const url = new URL(`${this.#baseUrl}/v1/speech-to-text/realtime`);
    url.searchParams.set('model_id', this.#modelId);
    url.searchParams.set('audio_format', this.audioFormat);
    url.searchParams.set('commit_strategy', this.#commitStrategy);
    if (this.#languageCode) {
      url.searchParams.set('language_code', this.#languageCode);
    }
    if (this.#vadSilenceThresholdSecs !== undefined) {
      url.searchParams.set('vad_silence_threshold_secs', String(this.#vadSilenceThresholdSecs));
    }
    return url.toString();
  }

  #handleMessage(raw: WebSocket.RawData): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof message.message_type === 'string' ? message.message_type : '';
    const payload =
      typeof message.data === 'object' && message.data !== null
        ? (message.data as Record<string, unknown>)
        : {};
    // ElevenLabs puts `text` on the top level of realtime transcript events;
    // keep `data.text` as a fallback for SDK-style payloads.
    const text =
      typeof message.text === 'string'
        ? message.text
        : typeof payload.text === 'string'
          ? payload.text
          : '';

    switch (type) {
      case 'partialTranscript':
      case 'partial_transcript':
        this.#emitTranscript({ kind: 'partial', text, isFinal: false });
        break;
      case 'committedTranscript':
      case 'committed_transcript':
      case 'finalTranscript':
      case 'final_transcript':
        this.#emitTranscript({ kind: 'final', text, isFinal: true });
        break;
      case 'scribeError':
      case 'scribe_error':
        this.#emitError(
          new Error(
            typeof message.message === 'string'
              ? message.message
              : typeof payload.message === 'string'
                ? payload.message
                : 'ElevenLabs STT error',
          ),
        );
        break;
    }
  }

  #emitTranscript(event: TranscriptEvent): void {
    for (const handler of this.#handlers) handler(event);
  }

  #emitError(error: Error): void {
    for (const handler of this.#errorHandlers) handler(error);
  }
}

// ------------------------------------------------------ Turn detection

export interface TurnDetectorOptions {
  sampleRate?: number;
  frameMs?: number;
  silenceThreshold?: number;
  minSpeechMs?: number;
  minSilenceMs?: number;
}

export interface TurnDetectionResult {
  isSpeech: boolean;
  turnEnded: boolean;
}

/**
 * Lightweight RMS-based voice activity detection for 16-bit little-endian
 * mono PCM. Declares a turn when speech is sustained past `minSpeechMs` and
 * ends it after `minSilenceMs` of silence.
 */
export class SilenceTurnDetector {
  readonly #frameSamples: number;
  readonly #frameBytes: number;
  readonly #frameMs: number;
  readonly #threshold: number;
  readonly #minSpeechMs: number;
  readonly #minSilenceMs: number;
  #speechMs = 0;
  #silenceMs = 0;
  #inTurn = false;

  constructor(options: TurnDetectorOptions = {}) {
    const sampleRate = options.sampleRate ?? 16000;
    this.#frameMs = options.frameMs ?? 20;
    this.#frameSamples = Math.round((sampleRate * this.#frameMs) / 1000);
    this.#frameBytes = this.#frameSamples * 2;
    this.#threshold = options.silenceThreshold ?? 400;
    this.#minSpeechMs = options.minSpeechMs ?? 300;
    this.#minSilenceMs = options.minSilenceMs ?? 800;
  }

  feed(pcm: Buffer): TurnDetectionResult {
    let turnEnded = false;

    for (let offset = 0; offset + this.#frameBytes <= pcm.length; offset += this.#frameBytes) {
      const rms = rmsOfFrame(pcm.subarray(offset, offset + this.#frameBytes));

      if (rms >= this.#threshold) {
        this.#silenceMs = 0;
        if (!this.#inTurn) {
          this.#speechMs += this.#frameMs;
          if (this.#speechMs >= this.#minSpeechMs) {
            this.#inTurn = true;
          }
        }
      } else if (this.#inTurn) {
        this.#silenceMs += this.#frameMs;
        if (this.#silenceMs >= this.#minSilenceMs) {
          turnEnded = true;
          this.#inTurn = false;
          this.#speechMs = 0;
          this.#silenceMs = 0;
        }
      } else {
        this.#speechMs = 0;
      }
    }

    return { isSpeech: this.#inTurn, turnEnded };
  }

  reset(): void {
    this.#speechMs = 0;
    this.#silenceMs = 0;
    this.#inTurn = false;
  }
}

function rmsOfFrame(frame: Buffer): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 2) {
    const sample = frame.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / (frame.length / 2));
}
