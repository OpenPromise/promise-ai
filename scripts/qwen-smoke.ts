import { loadConfig } from '@personal-ai/config';
import { ElevenLabsTTS } from '@personal-ai/elevenlabs';
import { QwenRealtimeClient } from '@personal-ai/qwen-realtime';

const config = loadConfig();

if (!config.qwenRealtime.configured) {
  console.error('Qwen Realtime is not configured (DASHSCOPE_API_KEY).');
  process.exit(1);
}

const userText = '你好，请用一句话介绍你自己。';
const expectedReply = '你好，我是你的私人 AI 助理，很高兴认识你。';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]);
}

// ---------------------------------------------------------------- TTS

console.log(`[tts] connecting to ${config.qwenRealtime.ttsModel}...`);
const tts = new QwenRealtimeClient({
  apiKey: config.qwenRealtime.apiKey,
  baseUrl: config.qwenRealtime.baseUrl,
  model: config.qwenRealtime.ttsModel,
});
let ttsAudioBytes = 0;
let ttsResponses = 0;
tts.onAudioDelta((event) => {
  ttsAudioBytes += event.data.length;
});
tts.onResponseCreated(() => {
  ttsResponses += 1;
});
tts.onResponseDone((event) => {
  console.log(`[tts] response.done status=${event.status}`);
  if (event.status === 'completed') tts.finishSession();
});
tts.onError((error) => {
  console.error('[tts] error:', error.message);
});

const ttsFinished = new Promise<void>((resolve) => {
  tts.onSessionFinished(resolve);
});

await tts.start();
console.log('[tts] connected');
await tts.updateSession({
  voice: config.qwenRealtime.ttsVoice,
  mode: 'server_commit',
  language_type: 'Chinese',
  response_format: 'pcm',
  sample_rate: 24_000,
});
console.log('[tts] session updated');

tts.appendText(expectedReply);
// One commit for the whole text: the server synthesizes it as one continuous
// unit, which sounds natural instead of choppy per-sentence units.
tts.commitText();
await withTimeout(ttsFinished, 60_000, 'TTS synthesis');
tts.close();

console.log(
  `[tts] done: responses=${ttsResponses}, audioBytes=${ttsAudioBytes}, voice=${config.qwenRealtime.ttsVoice}`,
);
if (ttsResponses === 0 || ttsAudioBytes === 0) {
  console.error('TTS smoke test failed: no audio was synthesized.');
  process.exit(1);
}

// ---------------------------------------------------------------- ASR

if (!config.elevenlabs.configured) {
  console.log('[asr] skipped: ElevenLabs not configured to synthesize the spoken sample.');
  console.log('Qwen smoke test passed (TTS only).');
  process.exit(0);
}

console.log(`[asr] connecting to ${config.qwenRealtime.asrModel}...`);
const asr = new QwenRealtimeClient({
  apiKey: config.qwenRealtime.apiKey,
  baseUrl: config.qwenRealtime.baseUrl,
  model: config.qwenRealtime.asrModel,
});
let finalTranscript: string | undefined;
asr.onTranscript((event) => {
  console.log(`[asr] transcript.${event.kind} = "${event.text}"`);
  if (event.kind === 'final') finalTranscript = event.text;
});
asr.onError((error) => {
  console.error('[asr] error:', error.message);
});

await asr.start();
console.log('[asr] connected');
await asr.updateSession({
  input_audio_format: 'pcm',
  sample_rate: 16_000,
  input_audio_transcription: { language: 'zh' },
  turn_detection: { type: 'server_vad', threshold: 0, silence_duration_ms: 400 },
});
console.log('[asr] session updated');

// Generate a 16 kHz PCM sample with ElevenLabs so the smoke test can speak
// to the ASR model without a microphone.
const speech = new ElevenLabsTTS({
  apiKey: config.elevenlabs.apiKey,
  voiceId: config.elevenlabs.voiceId,
  modelId: config.elevenlabs.model,
  languageCode: 'zh',
  outputFormat: 'pcm_16000',
});
const chunks: Buffer[] = [];
for await (const chunk of speech.synthesize(userText)) {
  chunks.push(chunk.data);
}
// trailing silence so server-side VAD commits the turn
const fullPcm = Buffer.concat([...chunks, Buffer.alloc(16_000 * 2 * 1.5)]);
console.log(`[asr] streaming ${fullPcm.length} bytes of PCM audio...`);

const transcriptDone = new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, 30_000);
  timer.unref?.();
  asr.onTranscript((event) => {
    if (event.kind === 'final' && event.text.trim()) {
      clearTimeout(timer);
      resolve();
    }
  });
});

for (let offset = 0; offset < fullPcm.length; offset += 3200) {
  asr.sendAudio(fullPcm.subarray(offset, offset + 3200));
  await new Promise((r) => setTimeout(r, 40));
}

await withTimeout(transcriptDone, 45_000, 'ASR recognition');
const asrFinished = new Promise<void>((resolve) => asr.onSessionFinished(resolve));
asr.finishSession();
await asrFinished;
asr.close();

console.log(`[asr] final transcript = "${finalTranscript ?? ''}"`);
if (!finalTranscript || !finalTranscript.trim()) {
  console.error('ASR smoke test failed: no final transcript.');
  process.exit(1);
}
console.log('Qwen smoke test passed (ASR + TTS).');
