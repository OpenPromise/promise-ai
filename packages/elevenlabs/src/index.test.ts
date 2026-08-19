import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket as WsClient } from 'ws';
import {
  ElevenLabsAbortError,
  ElevenLabsConfigError,
  ElevenLabsSTT,
  ElevenLabsTTS,
  SilenceTurnDetector,
  type TranscriptEvent,
} from './index.js';

function pcmFrame(amplitude: number, frameBytes: number): Buffer {
  const frame = Buffer.alloc(frameBytes);
  for (let i = 0; i < frameBytes; i += 2) {
    frame.writeInt16LE(amplitude, i);
  }
  return frame;
}

describe('SilenceTurnDetector', () => {
  const frameBytes = 640; // 20ms @ 16kHz mono 16-bit

  it('stays silent on zero audio', () => {
    const detector = new SilenceTurnDetector();
    const result = detector.feed(Buffer.alloc(frameBytes * 10));
    expect(result).toEqual({ isSpeech: false, turnEnded: false });
  });

  it('detects speech after minSpeechMs', () => {
    const detector = new SilenceTurnDetector();
    let result;
    for (let i = 0; i < 15; i++) {
      result = detector.feed(pcmFrame(3000, frameBytes));
    }
    expect(result).toEqual({ isSpeech: true, turnEnded: false });
  });

  it('ends the turn after minSilenceMs of silence', () => {
    const detector = new SilenceTurnDetector();
    for (let i = 0; i < 15; i++) {
      detector.feed(pcmFrame(3000, frameBytes));
    }
    let result;
    for (let i = 0; i < 40; i++) {
      result = detector.feed(Buffer.alloc(frameBytes));
    }
    expect(result?.turnEnded).toBe(true);
    expect(result?.isSpeech).toBe(false);
  });

  it('ignores short noise bursts', () => {
    const detector = new SilenceTurnDetector();
    const result = detector.feed(pcmFrame(3000, frameBytes * 5));
    expect(result).toEqual({ isSpeech: false, turnEnded: false });
  });
});

describe('ElevenLabsTTS', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws config errors without api key or voice id', async () => {
    const noKey = new ElevenLabsTTS({ voiceId: 'v1' });
    await expect(async () => {
      for await (const _chunk of noKey.synthesize('hi')) {
        // noop
      }
    }).rejects.toThrow(ElevenLabsConfigError);

    const noVoice = new ElevenLabsTTS({ apiKey: 'k' });
    await expect(async () => {
      for await (const _chunk of noVoice.synthesize('hi')) {
        // noop
      }
    }).rejects.toThrow(ElevenLabsConfigError);
  });

  it('streams audio chunks from the TTS endpoint', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('ID3audio-part1'));
        controller.enqueue(encoder.encode('-part2'));
        controller.close();
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const tts = new ElevenLabsTTS({
      apiKey: 'key',
      voiceId: 'voice-1',
      modelId: 'eleven_multilingual_v2',
      languageCode: 'zh',
      outputFormat: 'mp3_44100_128',
    });

    const chunks: Buffer[] = [];
    for await (const chunk of tts.synthesize('你好')) {
      chunks.push(chunk.data);
    }

    expect(Buffer.concat(chunks).toString()).toBe('ID3audio-part1-part2');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice-1/stream?output_format=mp3_44100_128',
    );
    const headers = init.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe('key');
    const body = JSON.parse(String(init.body)) as {
      model_id: string;
      text: string;
      language_code: string;
    };
    expect(body.model_id).toBe('eleven_multilingual_v2');
    expect(body.text).toBe('你好');
    expect(body.language_code).toBe('zh');
  });

  it('aborts synthesis when the caller signal fires', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('audio-part1'));
        // keep the stream open until aborted
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const tts = new ElevenLabsTTS({ apiKey: 'key', voiceId: 'voice-1' });
    const controller = new AbortController();
    const generator = tts
      .synthesize('你好', {
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();

    const first = await generator.next();
    expect(Buffer.from(first.value?.data ?? Buffer.alloc(0)).toString()).toBe('audio-part1');

    controller.abort();
    await expect(generator.next()).rejects.toThrow(ElevenLabsAbortError);
  });
});

describe('ElevenLabsSTT', () => {
  class FakeWebSocket {
    readyState = 1;
    sent: string[] = [];
    readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    on(event: string, cb: (...args: unknown[]) => void): this {
      const list = this.#listeners.get(event) ?? [];
      list.push(cb);
      this.#listeners.set(event, list);
      return this;
    }

    once(event: string, cb: (...args: unknown[]) => void): this {
      return this.on(event, cb);
    }

    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.#listeners.get(event) ?? []) cb(...args);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    removeAllListeners(): void {
      this.#listeners.clear();
    }

    close(): void {
      // noop
    }
  }

  it('throws a config error without an api key', async () => {
    const stt = new ElevenLabsSTT({});
    await expect(stt.start()).rejects.toThrow(ElevenLabsConfigError);
  });

  it('sends base64 audio chunks and emits transcripts', async () => {
    const fake = new FakeWebSocket();
    const stt = new ElevenLabsSTT({
      apiKey: 'key',
      audioFormat: 'pcm_16000',
      languageCode: 'zh',
      createWebSocket: () => fake as unknown as WsClient,
    });

    const startPromise = stt.start();
    fake.emit('open');
    await startPromise;

    const transcripts: TranscriptEvent[] = [];
    stt.onTranscript((event) => transcripts.push(event));

    await stt.sendAudio(Buffer.from([0x01, 0x02, 0x03]));
    expect(fake.sent).toHaveLength(1);
    const sent = JSON.parse(fake.sent[0] ?? '{}') as Record<string, string>;
    expect(sent.message_type).toBe('input_audio_chunk');
    expect(sent.audio_base_64).toBe(Buffer.from([0x01, 0x02, 0x03]).toString('base64'));

    fake.emit(
      'message',
      Buffer.from(JSON.stringify({ message_type: 'partialTranscript', data: { text: '你好' } })),
    );
    fake.emit(
      'message',
      Buffer.from(JSON.stringify({ message_type: 'committedTranscript', data: { text: '你好' } })),
    );

    expect(transcripts).toEqual([
      { kind: 'partial', text: '你好', isFinal: false },
      { kind: 'final', text: '你好', isFinal: true },
    ]);

    await stt.stop();
  });

  it('emits transcripts from top-level text (realtime wire format)', async () => {
    const fake = new FakeWebSocket();
    const stt = new ElevenLabsSTT({
      apiKey: 'key',
      languageCode: 'zh',
      createWebSocket: () => fake as unknown as WsClient,
    });
    const startPromise = stt.start();
    fake.emit('open');
    await startPromise;

    const transcripts: TranscriptEvent[] = [];
    stt.onTranscript((event) => transcripts.push(event));

    fake.emit(
      'message',
      Buffer.from(
        JSON.stringify({ message_type: 'partial_transcript', text: '你好，我是你的私人' }),
      ),
    );
    fake.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          message_type: 'committed_transcript',
          text: '你好，我是你的私人 AI 助理。',
        }),
      ),
    );

    expect(transcripts).toEqual([
      { kind: 'partial', text: '你好，我是你的私人', isFinal: false },
      { kind: 'final', text: '你好，我是你的私人 AI 助理。', isFinal: true },
    ]);

    await stt.stop();
  });

  it('includes language_code and vad params in the websocket url', async () => {
    const fake = new FakeWebSocket();
    const seenUrls: string[] = [];
    const stt = new ElevenLabsSTT({
      apiKey: 'key',
      languageCode: 'zh',
      vadSilenceThresholdSecs: 1.5,
      createWebSocket: (url) => {
        seenUrls.push(url);
        return fake as unknown as WsClient;
      },
    });
    const startPromise = stt.start();
    fake.emit('open');
    await startPromise;

    expect(seenUrls[0]).toContain('language_code=zh');
    expect(seenUrls[0]).toContain('vad_silence_threshold_secs=1.5');
    expect(seenUrls[0]).toContain('commit_strategy=vad');

    await stt.stop();
  });

  it('emits errors for scribeError events', async () => {
    const fake = new FakeWebSocket();
    const stt = new ElevenLabsSTT({
      apiKey: 'key',
      createWebSocket: () => fake as unknown as WsClient,
    });
    const startPromise = stt.start();
    fake.emit('open');
    await startPromise;

    const errors: Error[] = [];
    stt.onError((error) => errors.push(error));
    fake.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          message_type: 'scribeError',
          data: { message: 'something went wrong' },
        }),
      ),
    );

    expect(errors[0]?.message).toBe('something went wrong');
    await stt.stop();
  });

  it('emits errors from top-level message (realtime wire format)', async () => {
    const fake = new FakeWebSocket();
    const stt = new ElevenLabsSTT({
      apiKey: 'key',
      createWebSocket: () => fake as unknown as WsClient,
    });
    const startPromise = stt.start();
    fake.emit('open');
    await startPromise;

    const errors: Error[] = [];
    stt.onError((error) => errors.push(error));
    fake.emit(
      'message',
      Buffer.from(JSON.stringify({ message_type: 'scribe_error', message: 'bad audio' })),
    );

    expect(errors[0]?.message).toBe('bad audio');
    await stt.stop();
  });
});
