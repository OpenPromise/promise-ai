import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VISION_ENDPOINT,
  DEFAULT_VISION_MODEL,
  describeImage,
  sniffImageMime,
} from './vision.js';

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

describe('describeImage', () => {
  it('calls DeepSeek vision model with a data URL, bearer auth and returns the description', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(DEFAULT_VISION_ENDPOINT);
      expect(init?.headers).toMatchObject({ authorization: 'Bearer sk-test' });
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.model).toBe(DEFAULT_VISION_MODEL);
      const content = body.messages[0].content;
      expect(content[0].image_url.url).toContain('data:image/png;base64,');
      return new Response(JSON.stringify({ choices: [{ message: { content: '一只小猫' } }] }), {
        status: 200,
      });
    });
    const text = await describeImage({
      apiKey: 'sk-test',
      imageBytes: Buffer.concat([PNG_MAGIC, Buffer.from('img')]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toBe('一只小猫');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses custom endpoint and model when provided', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.model).toBe('custom-vision-model');
      return new Response(JSON.stringify({ choices: [{ message: { content: '自定义模型' } }] }), {
        status: 200,
      });
    });
    const text = await describeImage({
      apiKey: 'sk-test',
      model: 'custom-vision-model',
      endpoint: 'https://example.com/v1/chat/completions',
      imageBytes: PNG_MAGIC,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toBe('自定义模型');
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(
      'https://example.com/v1/chat/completions',
    );
  });

  it('throws when the DeepSeek API key is missing', async () => {
    await expect(
      describeImage({
        imageBytes: PNG_MAGIC,
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/DEEPSEEK_API_KEY/);
  });
});
