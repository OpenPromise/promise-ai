import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket as WsClient } from 'ws';
import {
  QwenConfigError,
  QwenRealtimeClient,
  type QwenAudioChunkEvent,
  type QwenFunctionCallEvent,
  type QwenTranscriptEvent,
} from './index.js';

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
    this.readyState = 3;
  }
}

function connectClient(fake: FakeWebSocket, apiKey = 'sk-ws-test'): QwenRealtimeClient {
  const client = new QwenRealtimeClient({
    apiKey,
    baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    createWebSocket: () => fake as unknown as WsClient,
  });
  void client.start();
  fake.emit('open');
  fake.emit('message', Buffer.from(JSON.stringify({ type: 'session.created', session: {} })));
  return client;
}

async function connectAsync(fake: FakeWebSocket): Promise<QwenRealtimeClient> {
  const client = connectClient(fake);
  // let the microtask queue flush the handshake resolution
  await Promise.resolve();
  return client;
}

describe('QwenRealtimeClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws a config error without an api key', async () => {
    const client = new QwenRealtimeClient({});
    await expect(client.start()).rejects.toThrow(QwenConfigError);
  });

  it('connects with the model query param and bearer auth', async () => {
    const fake = new FakeWebSocket();
    const seenUrls: string[] = [];
    const client = new QwenRealtimeClient({
      apiKey: 'sk-ws-test',
      baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
      createWebSocket: (url, options) => {
        seenUrls.push(url);
        expect((options.headers as { Authorization?: string }).Authorization).toBe(
          'Bearer sk-ws-test',
        );
        return fake as unknown as WsClient;
      },
    });
    const startPromise = client.start();
    fake.emit('open');
    fake.emit('message', Buffer.from(JSON.stringify({ type: 'session.created' })));
    await startPromise;

    expect(seenUrls[0]).toContain('model=qwen-audio-3.0-realtime-flash');
    client.close();
  });

  it('sends session.update with tools and resolves on session.updated', async () => {
    const fake = new FakeWebSocket();
    const client = await connectAsync(fake);

    const updatePromise = client.updateSession({
      modalities: ['text', 'audio'],
      voice: 'longanqian',
      instructions: '你是测试助理',
      turn_detection: { type: 'smart_turn', silence_duration_ms: 600 },
      tools: [
        {
          type: 'function',
          function: { name: 'time.get', description: '获取当前时间', parameters: {} },
        },
      ],
    });
    fake.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
    await updatePromise;

    const sent = JSON.parse(fake.sent[0] ?? '{}') as {
      type: string;
      session: {
        instructions: string;
        turn_detection: { type: string; silence_duration_ms: number };
        tools: Array<{ function: { name: string } }>;
      };
    };
    expect(sent.type).toBe('session.update');
    expect(sent.session.instructions).toBe('你是测试助理');
    expect(sent.session.turn_detection.type).toBe('smart_turn');
    expect(sent.session.turn_detection.silence_duration_ms).toBe(600);
    expect(sent.session.tools[0]?.function.name).toBe('time.get');
    client.close();
  });

  it('streams input audio as base64 input_audio_buffer.append', async () => {
    const fake = new FakeWebSocket();
    const client = await connectAsync(fake);

    client.sendAudio(Buffer.from([0x01, 0x02, 0x03]));
    const sent = JSON.parse(fake.sent[0] ?? '{}') as { type: string; audio: string };
    expect(sent.type).toBe('input_audio_buffer.append');
    expect(sent.audio).toBe(Buffer.from([0x01, 0x02, 0x03]).toString('base64'));
    client.close();
  });

  it('emits user transcripts from delta/completed events', async () => {
    const fake = new FakeWebSocket();
    const client = await connectAsync(fake);
    const transcripts: QwenTranscriptEvent[] = [];
    client.onTranscript((event) => transcripts.push(event));

    fake.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.delta',
          text: '你好',
          stash: '，我是',
        }),
      ),
    );
    fake.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: '你好，我是你的私人 AI 助理。',
        }),
      ),
    );

    expect(transcripts).toEqual([
      { kind: 'partial', text: '你好，我是' },
      { kind: 'final', text: '你好，我是你的私人 AI 助理。' },
    ]);
    client.close();
  });

  it('emits assistant transcript deltas and pcm audio chunks', async () => {
    const fake = new FakeWebSocket();
    const client = await connectAsync(fake);
    const textDeltas: string[] = [];
    const audioChunks: QwenAudioChunkEvent[] = [];
    client.onAssistantTranscript((delta) => textDeltas.push(delta));
    client.onAudioDelta((event) => audioChunks.push(event));

    fake.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'response.created',
          response: { id: 'resp_1', status: 'in_progress' },
        }),
      ),
    );
    fake.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'response.audio_transcript.delta',
          response_id: 'resp_1',
          delta: '好的',
        }),
      ),
    );
    fake.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'response.audio.delta',
          response_id: 'resp_1',
          delta: Buffer.from([0x11, 0x22]).toString('base64'),
        }),
      ),
    );

    expect(textDeltas).toEqual(['好的']);
    expect(audioChunks).toHaveLength(1);
    expect(audioChunks[0]?.data.equals(Buffer.from([0x11, 0x22]))).toBe(true);
    expect(audioChunks[0]?.format).toBe('pcm');
    expect(audioChunks[0]?.sampleRate).toBe(24_000);
    client.close();
  });

  it('sends TTS text buffer events and emits session.finished', async () => {
    const fake = new FakeWebSocket();
    const client = await connectAsync(fake);
    const finished: number[] = [];
    client.onSessionFinished(() => finished.push(1));

    client.appendText('你好，世界。');
    client.commitText();
    client.finishSession();

    const first = JSON.parse(fake.sent[0] ?? '{}') as { type: string; text: string };
    const second = JSON.parse(fake.sent[1] ?? '{}') as { type: string };
    const third = JSON.parse(fake.sent[2] ?? '{}') as { type: string };
    expect(first).toEqual({ type: 'input_text_buffer.append', text: '你好，世界。' });
    expect(second.type).toBe('input_text_buffer.commit');
    expect(third.type).toBe('session.finish');

    fake.emit('message', Buffer.from(JSON.stringify({ type: 'session.finished' })));
    expect(finished).toHaveLength(1);
    client.close();
  });

  it('uses the session sample_rate for output audio chunks', async () => {
    const fake = new FakeWebSocket();
    const client = await connectAsync(fake);
    const audioChunks: QwenAudioChunkEvent[] = [];
    client.onAudioDelta((event) => audioChunks.push(event));

    const updatePromise = client.updateSession({ voice: 'Cherry', sample_rate: 48_000 });
    fake.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
    await updatePromise;
    fake.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'response.audio.delta',
          delta: Buffer.from([0x11, 0x22]).toString('base64'),
        }),
      ),
    );

    expect(audioChunks[0]?.sampleRate).toBe(48_000);
    client.close();
  });

  it('emits function calls once and reports response.done with full text', async () => {
    const fake = new FakeWebSocket();
    const client = await connectAsync(fake);
    const calls: QwenFunctionCallEvent[] = [];
    const done: Array<{ status: string; text: string }> = [];
    client.onFunctionCall((event) => calls.push(event));
    client.onResponseDone((event) => done.push(event));

    fake.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'response.created',
          response: { id: 'resp_2' },
        }),
      ),
    );
    fake.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'response.function_call_arguments.done',
          response_id: 'resp_2',
          call_id: 'call_1',
          name: 'time.get',
          arguments: '{"tz":"Asia/Shanghai"}',
        }),
      ),
    );
    // The same call arrives again via output_item.done; it must not duplicate.
    fake.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'call_1',
            name: 'time.get',
            arguments: '{"tz":"Asia/Shanghai"}',
          },
        }),
      ),
    );
    fake.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'response.done',
          response: { id: 'resp_2', status: 'completed' },
        }),
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      callId: 'call_1',
      name: 'time.get',
      arguments: '{"tz":"Asia/Shanghai"}',
      responseId: 'resp_2',
    });
    expect(done).toHaveLength(1);
    expect(done[0]?.status).toBe('completed');
    client.close();
  });

  it('emits errors for error events and rejects pending updates', async () => {
    const fake = new FakeWebSocket();
    const client = await connectAsync(fake);
    const errors: Error[] = [];
    client.onError((error) => errors.push(error));

    const updatePromise = client.updateSession({ voice: 'longanqian' });
    fake.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', code: 'invalid_value', message: 'bad voice' },
        }),
      ),
    );

    await expect(updatePromise).rejects.toThrow('bad voice');
    expect(errors[0]?.message).toBe('bad voice');
    client.close();
  });

  it('rejects the handshake when the connection errors before session.created', async () => {
    const fake = new FakeWebSocket();
    const client = new QwenRealtimeClient({
      apiKey: 'sk-ws-test',
      createWebSocket: () => fake as unknown as WsClient,
    });
    const startPromise = client.start();
    fake.emit('error', new Error('401 Unauthorized'));
    await expect(startPromise).rejects.toThrow('401 Unauthorized');
  });

  it('sends function_call_output and response.create', async () => {
    const fake = new FakeWebSocket();
    const client = await connectAsync(fake);

    client.sendFunctionCallOutput('call_9', '{"ok":true}');
    client.createResponse();

    const first = JSON.parse(fake.sent[0] ?? '{}') as { type: string; item: { call_id: string } };
    const second = JSON.parse(fake.sent[1] ?? '{}') as { type: string };
    expect(first.type).toBe('conversation.item.create');
    expect(first.item.call_id).toBe('call_9');
    expect(second.type).toBe('response.create');
    client.close();
  });
});
