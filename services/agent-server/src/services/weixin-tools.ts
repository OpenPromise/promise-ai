import { readFile } from 'node:fs/promises';
import type { SessionStore } from '@personal-ai/memory';
import type { TTSProvider } from '@personal-ai/elevenlabs';
import type { Tool, ToolContext, ToolResult } from '@personal-ai/tools';

export interface WeixinToolOptions {
  /** weixin-bridge 地址（如 http://weixin-bridge:3100）。 */
  bridgeUrl: string;
  store: SessionStore;
  /** 语音合成工厂（ElevenLabs），用于 weixin.send_voice。 */
  tts?: () => TTSProvider | undefined;
  fetchImpl?: typeof fetch;
}

interface BridgeResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

async function postBridge(
  fetchImpl: typeof fetch,
  bridgeUrl: string,
  path: string,
  body: unknown,
  timeoutMs = 60_000,
): Promise<BridgeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${bridgeUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let json: unknown = raw;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      // 非 JSON 响应按文本返回
    }
    if (!response.ok) {
      const detail =
        typeof json === 'object' && json && 'error' in json
          ? String((json as { error?: unknown }).error ?? '')
          : raw.slice(0, 200);
      return { ok: false, error: `微信桥返回 ${response.status}：${detail}` };
    }
    return { ok: true, data: json };
  } catch (error) {
    return {
      ok: false,
      error: `调用微信桥失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 会话元数据里的微信对端（由 weixin-bridge 建会话时写入）。 */
async function resolveWeixinPeer(
  store: SessionStore,
  ctx: ToolContext,
): Promise<string | undefined> {
  try {
    const session = await store.getSession(ctx.sessionId);
    const metadata = session.metadata as { weixinPeer?: string } | undefined;
    return metadata?.weixinPeer;
  } catch {
    return undefined;
  }
}

/** 从本地路径或 URL 读取图片字节。 */
async function loadImageBytes(
  fetchImpl: typeof fetch,
  source: string,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  try {
    if (/^https?:\/\//i.test(source)) {
      const response = await fetchImpl(source);
      if (!response.ok) {
        return { ok: false, error: `下载图片失败（HTTP ${response.status}）` };
      }
      return { ok: true, bytes: Buffer.from(await response.arrayBuffer()) };
    }
    return { ok: true, bytes: await readFile(source) };
  } catch (error) {
    return {
      ok: false,
      error: `读取图片失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function synthesizeMp3(tts: TTSProvider, text: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of tts.synthesize(text)) {
    chunks.push(Buffer.from(chunk.data));
  }
  return Buffer.concat(chunks);
}

/**
 * 微信媒体发送工具：只在 weixin-bridge 创建的会话里可用（会话元数据含
 * weixinPeer）。图片支持服务器本地路径或 URL；语音用 TTS 合成后发送。
 */
export function createWeixinTools(options: WeixinToolOptions): Tool[] {
  const fetchImpl = options.fetchImpl ?? fetch;

  return [
    {
      name: 'weixin.send_image',
      description:
        '给当前微信会话发送一张图片。source 为服务器上可访问的图片文件路径，' +
        '或 http(s) 图片 URL。仅用于微信会话（用户从微信发起对话）。',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: '图片文件路径或 http(s) URL',
          },
        },
        required: ['source'],
      },
      permissionLevel: 1,
      timeoutMs: 60_000,
      async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
        const { source } = (input ?? {}) as { source?: string };
        if (!source?.trim()) return { ok: false, error: '缺少 source（图片路径或 URL）' };
        const peer = await resolveWeixinPeer(options.store, ctx);
        if (!peer) return { ok: false, error: '当前会话不是微信会话，无法发送图片' };
        const loaded = await loadImageBytes(fetchImpl, source.trim());
        if (!loaded.ok) return { ok: false, error: loaded.error };
        const result = await postBridge(fetchImpl, options.bridgeUrl, '/api/weixin/send-image', {
          sessionId: ctx.sessionId,
          imageBase64: loaded.bytes.toString('base64'),
        });
        return result.ok
          ? { ok: true, data: { sent: true, source: source.trim() } }
          : { ok: false, error: result.error ?? '发送图片失败' };
      },
    },
    {
      name: 'weixin.send_voice',
      description:
        '给当前微信会话发送一条语音消息：用 TTS 把 text 合成语音后发送。' +
        '仅用于微信会话（用户从微信发起对话）。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要朗读的文本' },
        },
        required: ['text'],
      },
      permissionLevel: 1,
      timeoutMs: 90_000,
      async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
        const { text } = (input ?? {}) as { text?: string };
        if (!text?.trim()) return { ok: false, error: '缺少 text' };
        const peer = await resolveWeixinPeer(options.store, ctx);
        if (!peer) return { ok: false, error: '当前会话不是微信会话，无法发送语音' };
        const tts = options.tts?.();
        if (!tts?.configured) {
          return { ok: false, error: '未配置 TTS（ELEVENLABS_API_KEY / VOICE_ID）' };
        }
        try {
          const mp3 = await synthesizeMp3(tts, text.trim());
          if (mp3.length === 0) return { ok: false, error: 'TTS 合成结果为空' };
          const result = await postBridge(fetchImpl, options.bridgeUrl, '/api/weixin/send-voice', {
            sessionId: ctx.sessionId,
            audioBase64: mp3.toString('base64'),
            encodeType: 7,
          });
          return result.ok
            ? { ok: true, data: { sent: true, bytes: mp3.length } }
            : { ok: false, error: result.error ?? '发送语音失败' };
        } catch (error) {
          return {
            ok: false,
            error: `语音合成失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
  ];
}
