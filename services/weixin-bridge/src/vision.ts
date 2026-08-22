/**
 * 微信收图理解：下载解密后的图片字节 -> 视觉模型描述。
 * 默认走 DeepSeek 官方 API（https://api.deepseek.com）的
 * deepseek-v4-flash-vision-exp 视觉模型（OpenAI 兼容协议）。
 */

export interface DescribeImageOptions {
  apiKey?: string;
  /** 视觉模型，默认 deepseek-v4-flash-vision-exp（DeepSeek 官方视觉模型，支持图片输入）。 */
  model?: string;
  /** OpenAI 兼容 chat/completions 端点，默认 DeepSeek 官方 https://api.deepseek.com/chat/completions。 */
  endpoint?: string;
  imageBytes: Buffer;
  prompt?: string;
  fetchImpl?: typeof fetch;
}

/** 默认视觉端点（DeepSeek 官方 API，OpenAI 兼容协议）。 */
export const DEFAULT_VISION_ENDPOINT = 'https://api.deepseek.com/chat/completions';
/** 默认视觉模型（DeepSeek-V4-Flash-Vision-Exp，官方实验性多模态模型，2026-08-21 上线）。 */
export const DEFAULT_VISION_MODEL = 'deepseek-v4-flash-vision-exp';

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

/** 调用视觉模型（OpenAI 兼容 chat/completions），返回图片描述文本。 */
export async function describeImage(options: DescribeImageOptions): Promise<string> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      '未配置 DEEPSEEK_API_KEY，无法识别图片：当前视觉模型 ' +
        `${DEFAULT_VISION_MODEL} 走 DeepSeek 官方 API（https://api.deepseek.com），` +
        'DASHSCOPE_API_KEY 仅对 DashScope 端点有效，不能用于 DeepSeek 端点',
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const mime = sniffImageMime(options.imageBytes);
  const base64 = options.imageBytes.toString('base64');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  timer.unref?.();
  let response: Response;
  try {
    response = await fetchImpl(options.endpoint?.trim() || DEFAULT_VISION_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model?.trim() || DEFAULT_VISION_MODEL,
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
