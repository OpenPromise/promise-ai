import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '@personal-ai/config';
import { ElevenLabsSTT, ElevenLabsTTS } from '@personal-ai/elevenlabs';

const config = loadConfig();

if (!config.elevenlabs.configured) {
  console.error('ElevenLabs is not configured (ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID).');
  process.exit(1);
}

const text = '你好，我是你的私人 AI 助理。';

async function collectAudio(tts: ElevenLabsTTS, input: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of tts.synthesize(input)) {
    chunks.push(chunk.data);
  }
  return Buffer.concat(chunks);
}

const mp3TTS = new ElevenLabsTTS({
  apiKey: config.elevenlabs.apiKey,
  voiceId: config.elevenlabs.voiceId,
  modelId: config.elevenlabs.model,
  languageCode: 'zh',
  outputFormat: 'mp3_44100_128',
});
const pcmTTS = new ElevenLabsTTS({
  apiKey: config.elevenlabs.apiKey,
  voiceId: config.elevenlabs.voiceId,
  modelId: config.elevenlabs.model,
  languageCode: 'zh',
  outputFormat: 'pcm_16000',
});

const outDir = path.join(import.meta.dirname, 'out');
await mkdir(outDir, { recursive: true });

console.log('TTS: generating MP3...');
const mp3 = await collectAudio(mp3TTS, text);
await writeFile(path.join(outDir, 'sample.mp3'), mp3);
console.log(`TTS: MP3 written (${mp3.length} bytes)`);

console.log('TTS: generating PCM (16kHz mono)...');
const pcm = await collectAudio(pcmTTS, text);
await writeFile(path.join(outDir, 'sample.pcm'), pcm);
console.log(`TTS: PCM written (${pcm.length} bytes)`);

// trailing silence so the VAD commit strategy finalizes the segment
const silence = Buffer.alloc(16000 * 2 * 1.5);
const fullPcm = Buffer.concat([pcm, silence]);

console.log('STT: transcribing PCM via realtime WebSocket...');
const stt = new ElevenLabsSTT({
  apiKey: config.elevenlabs.apiKey,
  audioFormat: 'pcm_16000',
  commitStrategy: 'vad',
  languageCode: 'zh',
  vadSilenceThresholdSecs: 0.6,
});

const transcriptPromise = new Promise<string>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error('STT transcription timed out, no non-empty transcript')),
    30000,
  );
  stt.onTranscript((event) => {
    console.log(`STT: ${event.kind} event, isFinal=${event.isFinal}, text="${event.text}"`);
    if (event.isFinal && event.text.trim().length > 0) {
      clearTimeout(timer);
      resolve(event.text);
    }
  });
  stt.onError((error) => {
    clearTimeout(timer);
    reject(error);
  });
});

await stt.start();
for (let offset = 0; offset < fullPcm.length; offset += 3200) {
  await stt.sendAudio(fullPcm.subarray(offset, offset + 3200));
  await new Promise((r) => setTimeout(r, 40));
}

const transcript = await transcriptPromise;
await stt.stop();
console.log(`STT: non-empty transcript = "${transcript}"`);
console.log('Voice smoke test passed.');
