/**
 * 腾讯 iLink（微信 ClawBot）HTTP 客户端。
 * 协议参考 OpenClaw 微信通道插件（MIT，仅作架构参考，本实现为独立编写）：
 * - 扫码登录：get_bot_qrcode + get_qrcode_status 长轮询
 * - 消息：getupdates 长轮询 / sendmessage / sendtyping / getconfig / notifystart/stop
 * - 鉴权：AuthorizationType=ilink_bot_token + Bearer token + X-WECHAT-UIN
 */
import { randomBytes, randomUUID } from 'node:crypto';

export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const ILINK_APP_ID = 'bot';
export const ILINK_BOT_TYPE = '3';
export const STALE_TOKEN_ERRCODE = -14;

export interface BaseInfo {
  channel_version?: string;
  bot_agent?: string;
}

export interface TextItem {
  text?: string;
}

export interface VoiceItem {
  /** 语音转文字内容（服务端已转写时提供）。 */
  text?: string;
}

export interface MessageItem {
  type?: number;
  text_item?: TextItem;
  voice_item?: VoiceItem;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  /** 1=用户消息，2=机器人消息。 */
  message_type?: number;
  /** 0=new 1=generating 2=finish。 */
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  /** 客户端需要缓存并在下次请求时原样回传。 */
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageResp {
  ret?: number;
  errmsg?: string;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export type QrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect';

export interface QrStatusResponse {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
}

export interface ILinkClientOptions {
  baseUrl?: string;
  token?: string;
  appId?: string;
  /** 形如 "0.1.0"；编码为 uint32 放进 iLink-App-ClientVersion。 */
  channelVersion?: string;
  botAgent?: string;
  fetchImpl?: typeof fetch;
}

function encodeClientVersion(version: string): number {
  const parts = version.split('.').map((part) => parseInt(part, 10) || 0);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/** X-WECHAT-UIN：随机 uint32 -> 十进制字符串 -> base64。 */
function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

export class ILinkError extends Error {
  readonly ret?: number;
  readonly errcode?: number;

  constructor(message: string, ret?: number, errcode?: number) {
    super(message);
    this.name = 'ILinkError';
    this.ret = ret;
    this.errcode = errcode;
  }
}

export class ILinkClient {
  readonly baseUrl: string;
  readonly token?: string;
  readonly #appId: string;
  readonly #clientVersion: number;
  readonly #botAgent: string;
  readonly #channelVersion: string;
  readonly #fetch: typeof fetch;

  constructor(options: ILinkClientOptions = {}) {
    this.baseUrl = (options.baseUrl?.trim() || ILINK_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.token = options.token?.trim() || undefined;
    this.#appId = options.appId?.trim() || ILINK_APP_ID;
    this.#channelVersion = options.channelVersion?.trim() || '0.1.0';
    this.#clientVersion = encodeClientVersion(this.#channelVersion);
    this.#botAgent = options.botAgent?.trim() || 'PromiseAi/0.1.0';
    this.#fetch = options.fetchImpl ?? fetch;
  }

  #commonHeaders(): Record<string, string> {
    return {
      'iLink-App-Id': this.#appId,
      'iLink-App-ClientVersion': String(this.#clientVersion),
    };
  }

  #postHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomWechatUin(),
      ...this.#commonHeaders(),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  #baseInfo(): BaseInfo {
    return { channel_version: this.#channelVersion, bot_agent: this.#botAgent };
  }

  async #postJson<T>(endpoint: string, body: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await this.#fetch(`${this.baseUrl}/${endpoint}`, {
        method: 'POST',
        headers: this.#postHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new ILinkError(`ilink ${endpoint} HTTP ${response.status}: ${raw.slice(0, 200)}`);
      }
      return JSON.parse(raw) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async #getJson<T>(
    endpoint: string,
    timeoutMs: number,
    signal?: AbortSignal,
    baseUrl?: string,
  ): Promise<T> {
    const base = (baseUrl?.trim() || this.baseUrl).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.#fetch(`${base}/${endpoint}`, {
        method: 'GET',
        headers: this.#commonHeaders(),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new ILinkError(`ilink ${endpoint} HTTP ${response.status}: ${raw.slice(0, 200)}`);
      }
      return JSON.parse(raw) as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 获取登录二维码（携带本机已有 token 列表，便于服务端识别老设备）。 */
  async fetchQrCode(localTokenList: string[] = []): Promise<QrCodeResponse> {
    return this.#postJson<QrCodeResponse>(
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(ILINK_BOT_TYPE)}`,
      { local_token_list: localTokenList },
      20_000,
    );
  }

  /** 长轮询二维码状态（最多 35s），可携带配对码；baseUrl 允许 IDC 重定向。 */
  async pollQrStatus(
    qrcode: string,
    verifyCode?: string,
    signal?: AbortSignal,
    baseUrl?: string,
  ): Promise<QrStatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    const base = (baseUrl?.trim() || this.baseUrl).replace(/\/+$/, '');
    try {
      return await this.#getJson<QrStatusResponse>(endpoint, 35_000, signal, base);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { status: 'wait' };
      }
      // 网络/网关抖动视为等待，继续轮询。
      return { status: 'wait' };
    }
  }

  /** 长轮询拉取消息；客户端超时属正常控制流，返回空结果。 */
  async getUpdates(
    syncBuf: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<GetUpdatesResp> {
    const timeoutMs = options.timeoutMs ?? 35_000;
    try {
      return await this.#postJson<GetUpdatesResp>(
        'ilink/bot/getupdates',
        { get_updates_buf: syncBuf, base_info: this.#baseInfo() },
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { ret: 0, msgs: [], get_updates_buf: syncBuf };
      }
      throw error;
    }
  }

  async sendMessage(msg: WeixinMessage): Promise<void> {
    const resp = await this.#postJson<SendMessageResp>(
      'ilink/bot/sendmessage',
      { msg, base_info: this.#baseInfo() },
      15_000,
    );
    if (resp.ret !== undefined && resp.ret !== 0) {
      throw new ILinkError(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`, resp.ret);
    }
  }

  async getConfig(ilinkUserId: string, contextToken?: string): Promise<GetConfigResp> {
    return this.#postJson<GetConfigResp>(
      'ilink/bot/getconfig',
      { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: this.#baseInfo() },
      10_000,
    );
  }

  async sendTyping(ilinkUserId: string, typingTicket?: string, status = 1): Promise<void> {
    await this.#postJson<{ ret?: number }>(
      'ilink/bot/sendtyping',
      {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status,
        base_info: this.#baseInfo(),
      },
      10_000,
    );
  }

  async notifyStart(): Promise<void> {
    await this.#postJson<{ ret?: number }>(
      'ilink/bot/msg/notifystart',
      { base_info: this.#baseInfo() },
      10_000,
    );
  }

  async notifyStop(): Promise<void> {
    await this.#postJson<{ ret?: number }>(
      'ilink/bot/msg/notifystop',
      { base_info: this.#baseInfo() },
      10_000,
    );
  }
}

/** 构造回复消息（text）。 */
export function buildReplyMessage(params: {
  to: string;
  text: string;
  contextToken?: string;
  runId?: string;
}): WeixinMessage {
  return {
    from_user_id: '',
    to_user_id: params.to,
    client_id: `promise-ai-${randomUUID()}`,
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: params.text } }],
    ...(params.contextToken ? { context_token: params.contextToken } : {}),
    ...(params.runId ? { run_id: params.runId } : {}),
  };
}

/** 从入站消息中提取文本（纯文本优先，其次语音转写）。 */
export function extractInboundText(msg: WeixinMessage): string {
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) return item.text_item.text;
  }
  for (const item of msg.item_list ?? []) {
    if (item.type === 3 && item.voice_item?.text) return item.voice_item.text;
  }
  return '';
}
