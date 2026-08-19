import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { anyAudioToSilkVoice, pcmToSilk, SILK_SAMPLE_RATE } from './silk.js';

const execFileAsync = promisify(execFile);

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}

/** 生成单声道 pcm_s16le 正弦波。 */
function sinePcm(seconds: number, sampleRate = SILK_SAMPLE_RATE, frequency = 440): Buffer {
  const samples = Math.floor(seconds * sampleRate);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.3;
    buffer.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return buffer;
}

async function makeMp3(seconds = 1): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wx-mp3-'));
  const out = path.join(dir, 't.mp3');
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${seconds}`,
        '-f',
        'mp3',
        out,
      ],
      { timeout: 30_000 },
    );
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe('pcmToSilk', () => {
  it('encodes pcm_s16le to non-empty silk with a plausible duration', async () => {
    const pcm = sinePcm(0.2);
    const { silk, durationMs } = await pcmToSilk(pcm);
    expect(silk.length).toBeGreaterThan(0);
    expect(durationMs).toBeGreaterThan(100);
    expect(durationMs).toBeLessThan(400);
  });
});

describe('anyAudioToSilkVoice', () => {
  it.skipIf(!hasFfmpeg)('converts an mp3 to silk (WeChat native voice format)', async () => {
    const mp3 = await makeMp3(1);
    const { silk, sampleRate, durationMs } = await anyAudioToSilkVoice(mp3);
    expect(silk.length).toBeGreaterThan(0);
    expect(sampleRate).toBe(SILK_SAMPLE_RATE);
    expect(durationMs).toBeGreaterThan(700);
    expect(durationMs).toBeLessThan(1500);
  });
});
