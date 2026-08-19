import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 微信语音标准采样率。 */
export const SILK_SAMPLE_RATE = 24_000;

export interface SilkVoice {
  silk: Buffer;
  sampleRate: number;
  durationMs: number;
}

/** pcm_s16le（单声道）编码为 SILK；返回 silk 字节与时长（毫秒）。 */
export async function pcmToSilk(
  pcm: Uint8Array,
  sampleRate = SILK_SAMPLE_RATE,
): Promise<{ silk: Buffer; durationMs: number }> {
  const { encode } = await import('silk-wasm');
  const result = await encode(pcm, sampleRate);
  return { silk: Buffer.from(result.data), durationMs: result.duration };
}

/** ffmpeg 把任意音频（mp3/wav/…）转成单声道 pcm_s16le。 */
export async function anyAudioToPcm(input: Buffer, sampleRate = SILK_SAMPLE_RATE): Promise<Buffer> {
  const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
  const dir = await mkdtemp(path.join(tmpdir(), 'wx-audio-'));
  const inFile = path.join(dir, 'input.bin');
  const outFile = path.join(dir, 'out.pcm');
  try {
    await writeFile(inFile, input);
    await execFileAsync(
      ffmpeg,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        inFile,
        '-f',
        's16le',
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        outFile,
      ],
      { timeout: 60_000 },
    );
    return await readFile(outFile);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`音频转码失败（需要 ffmpeg）：${detail.slice(0, 300)}`, {
      cause: error,
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 把 TTS 音频（mp3 等）编码为微信原生语音格式 SILK。 */
export async function anyAudioToSilkVoice(input: Buffer): Promise<SilkVoice> {
  const pcm = await anyAudioToPcm(input);
  if (pcm.length === 0) throw new Error('音频转码结果为空');
  const { silk, durationMs } = await pcmToSilk(pcm);
  if (silk.length === 0) throw new Error('SILK 编码结果为空');
  return { silk, sampleRate: SILK_SAMPLE_RATE, durationMs };
}
