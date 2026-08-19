import { describe, expect, it, vi } from 'vitest';
import { describeImageWithDashScope, sniffImageMime } from './vision.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('sniffImageMime', () => {
  it('detects png / jpeg / gif / webp', () => {
    expect(sniffImageMime(Buffer.concat([PNG_MAGIC, Buffer.from('x')]))).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a...'))).toBe('image/gif');
    expect(sniffImageMime(Buffer.concat([Buffer.from('RIFFxxxxWEBP'), Buffer.from('y')]))).toBe(
      'image/webp',
    );
    expect(sniffImageMime(Buffer.from('unknown'))).toBe('image/jpeg');
  });
});

describe('describeImageWithDashScope', () => {
  it('calls the vision model with a data URL and returns the description', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.model).toBe('qwen3.8-max');
      const content = body.messages[0].content;
      expect(content[0].image_url.url).toContain('data:image/png;base64,');
      return new Response(JSON.stringify({ choices: [{ message: { content: '一只小猫' } }] }), {
        status: 200,
      });
    });
    const text = await describeImageWithDashScope({
      apiKey: 'sk-test',
      imageBytes: Buffer.concat([PNG_MAGIC, Buffer.from('img')]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toBe('一只小猫');
  });

  it('throws when the API key is missing', async () => {
    await expect(
      describeImageWithDashScope({
        imageBytes: PNG_MAGIC,
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/DASHSCOPE_API_KEY/);
  });
});
