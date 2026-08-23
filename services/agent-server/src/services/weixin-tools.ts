import { readFile } from 'node:fs/promises';
import type { SessionStore } from '@personal-ai/memory';
import type { Tool, ToolContext, ToolResult } from '@personal-ai/tools';
import { missingConfigHint } from './tool-execution.js';

export interface WeixinToolOptions {
  /** weixin-bridge 地址（如 http://weixin-bridge:3100）。 */
  bridgeUrl: string;
  store: SessionStore;
  /** 微信桥共享 token（BRIDGE_TOKEN）：bridge 端点鉴权用，未配置时不带。 */
  bridgeToken?: string;
  fetchImpl?: typeof fetch;
}

interface BridgeResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * 微信桥 401 的配置指引：桥端鉴权只认 BRIDGE_TOKEN（未配置/缺失/不匹配都返回
 * 401），报错即告诉上层去哪补（agent-server 与 weixin-bridge 两侧要一致）。
 */
const BRIDGE_AUTH_HINT = missingConfigHint(
  'BRIDGE_TOKEN（weixin-bridge 共享鉴权 token，未配置/缺失/与桥端不一致）',
  '环境变量 .env 的 BRIDGE_TOKEN',
  '在 .env 设置 BRIDGE_TOKEN=<token>，且与 weixin-bridge 服务启动时使用的 token 保持一致',
);

async function postBridge(
  fetchImpl: typeof fetch,
  bridgeUrl: string,
  path: string,
  body: unknown,
  timeoutMs = 60_000,
  token?: string,
): Promise<BridgeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${bridgeUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-bridge-token': token } : {}),
      },
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
      return {
        ok: false,
        error: `微信桥返回 ${response.status}：${detail}${response.status === 401 ? BRIDGE_AUTH_HINT : ''}`,
      };
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

async function getBridge(
  fetchImpl: typeof fetch,
  bridgeUrl: string,
  path: string,
  timeoutMs = 15_000,
  token?: string,
): Promise<BridgeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${bridgeUrl.replace(/\/+$/, '')}${path}`, {
      ...(token ? { headers: { 'x-bridge-token': token } } : {}),
      method: 'GET',
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
      return {
        ok: false,
        error: `微信桥返回 ${response.status}：${detail}${response.status === 401 ? BRIDGE_AUTH_HINT : ''}`,
      };
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

/**
 * 微信媒体发送工具：只在 weixin-bridge 创建的会话里可用（会话元数据含
 * weixinPeer）。目前支持发送图片（服务器本地路径或 URL）。
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
      timeoutMs: 120_000,
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
        }, 120_000, options.bridgeToken);
        return result.ok
          ? { ok: true, data: { sent: true, source: source.trim() } }
          : { ok: false, error: result.error ?? '发送图片失败' };
      },
    },
    {
      name: 'weixin.list_files',
      description:
        '列出微信文件库里的文件（文件名、大小、修改时间）。' +
        '文件库是服务器上的专属文件夹，可用于查找用户想要的文件。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      timeoutMs: 20_000,
      async execute(): Promise<ToolResult> {
        const result = await getBridge(fetchImpl, options.bridgeUrl, '/api/weixin/files', 15_000, options.bridgeToken);
        if (!result.ok) return { ok: false, error: result.error ?? '获取文件列表失败' };
        const data = (result.data ?? {}) as { files?: Array<{ name: string; size: number }> };
        return {
          ok: true,
          data: { count: data.files?.length ?? 0, files: data.files ?? [] },
        };
      },
    },
    {
      name: 'weixin.delete_file',
      description:
        '按完整文件名从微信文件库删除文件（永久删除，不可恢复）。' +
        '只接受精确文件名（与 send_file 的模糊匹配不同）：模糊词会被拒绝并列出候选，' +
        '防止"一删一大片"。任何会话都可用。',
      inputSchema: {
        type: 'object',
        properties: {
          fileName: {
            type: 'string',
            description: '要删除的文件名或关键词',
          },
        },
        required: ['fileName'],
      },
      permissionLevel: 1,
      timeoutMs: 20_000,
      async execute(input: unknown): Promise<ToolResult> {
        const { fileName } = (input ?? {}) as { fileName?: string };
        if (!fileName?.trim()) return { ok: false, error: '缺少 fileName' };
        const result = await postBridge(fetchImpl, options.bridgeUrl, '/api/weixin/delete-file', {
          fileName: fileName.trim(),
        }, 20_000, options.bridgeToken);
        if (!result.ok) return { ok: false, error: result.error ?? '删除文件失败' };
        return { ok: true, data: result.data };
      },
    },
    {
      name: 'weixin.send_file',
      description:
        '从微信文件库按文件名查找并发送文件到微信。支持精确/前缀/包含匹配' +
        '（如「菜单.psd」或「菜单」）。当前会话若是微信会话则发给该用户，' +
        '否则发送到已绑定的微信账号（任何会话都可用）。' +
        '这是后台异步发送：工具立即返回 jobId，上传/投递在后台执行，进度与' +
        '完成/失败会由微信进度消息实时推送，无需等待结果，也不要自动重试。',
      inputSchema: {
        type: 'object',
        properties: {
          fileName: {
            type: 'string',
            description: '要发送的文件名或关键词',
          },
        },
        required: ['fileName'],
      },
      permissionLevel: 1,
      timeoutMs: 20_000,
      async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
        const { fileName } = (input ?? {}) as { fileName?: string };
        if (!fileName?.trim()) return { ok: false, error: '缺少 fileName' };
        const result = await postBridge(
          fetchImpl,
          options.bridgeUrl,
          '/api/weixin/send-file-async',
          {
            sessionId: ctx.sessionId,
            fileName: fileName.trim(),
          },
          20_000,
          options.bridgeToken,
        );
        if (!result.ok) return { ok: false, error: result.error ?? '发送文件失败' };
        return { ok: true, data: result.data };
      },
    },
  ];
}
