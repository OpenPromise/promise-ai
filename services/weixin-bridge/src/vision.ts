/**
 * 微信收图理解：下载解密后的图片字节 -> DashScope 视觉模型描述。
 */

export interface DescribeImageOptions {
  apiKey?: string;
  /** 视觉模型，默认 qwen3.8-max（兼容视觉输入）。 */
  model?: string;
  imageBytes: Buffer;
  prompt?: string;
  fetchImpl?: typeof fetch;
}

/** 根据魔数嗅探图片 MIME（png/jpeg/gif/webp）。 */
export function sniffImageMime(bytes: Buffer): string {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && bytes.subarray(0, 4).toString('ascii') === 'GIF8') {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

const DEFAULT_PROMPT =
  '你是视觉理解助手。请用中文简洁描述这张图片：主体、场景、关键文字（如有）。' +
  '如果是截图，重点描述界面元素和文字内容。不要猜测用户意图，只描述看到的内容。';

/** 调用 DashScope OpenAI 兼容视觉接口，返回图片描述文本。 */
export async function describeImageWithDashScope(options: DescribeImageOptions): Promise<string> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY 未配置，无法识别图片');
  const fetchImpl = options.fetchImpl ?? fetch;
  const mime = sniffImageMime(options.imageBytes);
  const base64 = options.imageBytes.toString('base64');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  timer.unref?.();
  let response: Response;
  try {
    response = await fetchImpl('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model?.trim() || 'qwen3.8-max',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:${mime};base64,${base64}` },
              },
              { type: 'text', text: options.prompt ?? DEFAULT_PROMPT },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`视觉模型调用失败（HTTP ${response.status}）：${raw.slice(0, 200)}`);
  }
  const data = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('视觉模型返回为空');
  return content;
}
