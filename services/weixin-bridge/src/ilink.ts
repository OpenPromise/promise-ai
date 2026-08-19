/**
 * 腾讯 iLink（微信 ClawBot）HTTP 客户端。
 * 协议参考 OpenClaw 微信通道插件（MIT，仅作架构参考，本实现为独立编写）：
 * - 扫码登录：get_bot_qrcode + get_qrcode_status 长轮询
 * - 消息：getupdates 长轮询 / sendmessage / sendtyping / getconfig / notifystart/stop
 * - 鉴权：AuthorizationType=ilink_bot_token + Bearer token + X-WECHAT-UIN
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
/** 微信 CDN（媒体加密上传/下载）域名。 */
export const ILINK_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
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

export interface MessageItem {
  type?: number;
  text_item?: TextItem;
  voice_item?: VoiceItem;
  image_item?: ImageItem;
  file_item?: FileItem;
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

export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
} as const;

export interface GetUploadUrlReq {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  rawsize?: number;
  rawfilemd5?: string;
  filesize?: number;
  no_need_thumb?: boolean;
  aeskey?: string;
}

export interface GetUploadUrlResp {
  upload_param?: string;
  upload_full_url?: string;
}

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface ImageItem {
  media?: CDNMedia;
  mid_size?: number;
  /** 入站图片的 AES key（hex，16 字节）；优先于 media.aes_key。 */
  aeskey?: string;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  len?: string;
}

export interface VoiceItem {
  /** 语音转文字内容（服务端已转写时提供）。 */
  text?: string;
  media?: CDNMedia;
  /** 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex */
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;
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

export interface UploadedMediaInfo {
  downloadParam: string;
  aesKeyBase64: string;
  ciphertextSize: number;
  plaintextSize: number;
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
      // 大文件（几十 MB）时服务端要校验 CDN 文件后才回执，15s 会假超时。
      120_000,
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

  /** 获取 CDN 预签名上传参数（图片/语音等媒体）。 */
  async getUploadUrl(params: GetUploadUrlReq): Promise<GetUploadUrlResp> {
    const resp = await this.#postJson<GetUploadUrlResp & { ret?: number; errmsg?: string }>(
      'ilink/bot/getuploadurl',
      { ...params, base_info: this.#baseInfo() },
      30_000,
    );
    if (resp.ret !== undefined && resp.ret !== 0) {
      throw new ILinkError(`getUploadUrl ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`, resp.ret);
    }
    return resp;
  }

  /**
   * AES-128-ECB 加密并上传到微信 CDN，返回下载用的 encrypt_query_param。
   * 4xx 直接失败，5xx 重试最多 3 次。
   */
  async uploadBufferToCdn(params: {
    plaintext: Buffer;
    filekey: string;
    aeskey: Buffer;
    uploadFullUrl?: string;
    uploadParam?: string;
    cdnBaseUrl?: string;
  }): Promise<string> {
    const { plaintext, filekey, aeskey } = params;
    const cdnBase = (params.cdnBaseUrl?.trim() || ILINK_CDN_BASE_URL).replace(/\/+$/, '');
    const uploadUrl =
      params.uploadFullUrl?.trim() ||
      `${cdnBase}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam ?? '')}&filekey=${encodeURIComponent(filekey)}`;
    const ciphertext = encryptAesEcb(plaintext, aeskey);

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180_000);
      timer.unref?.();
      try {
        const response = await this.#fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
          signal: controller.signal,
        });
        if (response.status >= 400 && response.status < 500) {
          const detail = response.headers.get('x-error-message') ?? (await response.text());
          throw new ILinkError(`CDN 上传客户端错误 ${response.status}: ${detail.slice(0, 200)}`);
        }
        if (response.status !== 200) {
          const detail = response.headers.get('x-error-message') ?? `status ${response.status}`;
          throw new ILinkError(`CDN 上传服务端错误：${detail.slice(0, 200)}`);
        }
        const downloadParam = response.headers.get('x-encrypted-param');
        if (!downloadParam) throw new ILinkError('CDN 响应缺少 x-encrypted-param');
        return downloadParam;
      } catch (error) {
        lastError = error;
        if (error instanceof ILinkError && error.message.includes('客户端错误')) throw error;
        if (attempt < 3) continue;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new ILinkError('CDN 上传失败');
  }

  /** 上传图片并发送给指定微信用户。 */
  async sendImageToUser(params: {
    to: string;
    image: Buffer;
    contextToken?: string;
    runId?: string;
  }): Promise<void> {
    const { to, image } = params;
    const uploaded = await this.uploadMediaBytes(to, UploadMediaType.IMAGE, image);
    await this.sendMessage({
      from_user_id: '',
      to_user_id: to,
      client_id: `promise-ai-${randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: [
        {
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: uploaded.downloadParam,
              aes_key: uploaded.aesKeyBase64,
              encrypt_type: 1,
            },
            mid_size: uploaded.ciphertextSize,
          },
        },
      ],
      ...(params.contextToken ? { context_token: params.contextToken } : {}),
      ...(params.runId ? { run_id: params.runId } : {}),
    });
  }

  /** 上传文件并以文件消息（file_item）发送给指定微信用户。 */
  async sendFileToUser(params: {
    to: string;
    file: Buffer;
    fileName: string;
    contextToken?: string;
    runId?: string;
  }): Promise<void> {
    const { to, file, fileName } = params;
    const uploaded = await this.uploadMediaBytes(to, UploadMediaType.FILE, file);
    await this.sendUploadedFileToUser({
      to,
      fileName,
      uploaded,
      contextToken: params.contextToken,
      runId: params.runId,
    });
  }

  /** 用已上传的媒体信息发送文件消息（供后台任务分步上报进度）。 */
  async sendUploadedFileToUser(params: {
    to: string;
    fileName: string;
    uploaded: UploadedMediaInfo;
    contextToken?: string;
    runId?: string;
  }): Promise<void> {
    const { to, fileName, uploaded } = params;
    await this.sendMessage({
      from_user_id: '',
      to_user_id: to,
      client_id: `promise-ai-${randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: [
        {
          type: 4,
          file_item: {
            media: {
              encrypt_query_param: uploaded.downloadParam,
              aes_key: uploaded.aesKeyBase64,
              encrypt_type: 1,
            },
            file_name: fileName,
            len: String(uploaded.plaintextSize),
          },
        },
      ],
      ...(params.contextToken ? { context_token: params.contextToken } : {}),
      ...(params.runId ? { run_id: params.runId } : {}),
    });
  }

  /**
   * 下载并解密入站 CDN 媒体（图片等）。key 兼容两种编码：
   * base64(16 raw bytes) 或 base64(32 hex chars)。
   */
  async downloadMedia(params: {
    encryptQueryParam?: string;
    fullUrl?: string;
    aesKeyBase64?: string;
    cdnBaseUrl?: string;
  }): Promise<Buffer> {
    const cdnBase = (params.cdnBaseUrl?.trim() || ILINK_CDN_BASE_URL).replace(/\/+$/, '');
    const url =
      params.fullUrl?.trim() ||
      `${cdnBase}/download?encrypted_query_param=${encodeURIComponent(params.encryptQueryParam ?? '')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.#fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new ILinkError(`CDN 下载失败 ${response.status}`);
    }
    const encrypted = Buffer.from(await response.arrayBuffer());
    if (!params.aesKeyBase64) return encrypted;
    return decryptAesEcb(encrypted, parseAesKey(params.aesKeyBase64));
  }

  /** 加密上传媒体到 CDN，返回发送消息所需的引用信息（供进度分步）。 */
  async uploadMediaBytes(
    toUserId: string,
    mediaType: number,
    plaintext: Buffer,
  ): Promise<UploadedMediaInfo> {
    const rawsize = plaintext.length;
    const rawfilemd5 = createHashMd5(plaintext);
    const filekey = randomBytes(16).toString('hex');
    const aeskey = randomBytes(16);
    const filesize = aesEcbPaddedSize(rawsize);

    const resp = await this.getUploadUrl({
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString('hex'),
    });
    const downloadParam = await this.uploadBufferToCdn({
      plaintext,
      filekey,
      aeskey,
      uploadFullUrl: resp.upload_full_url,
      uploadParam: resp.upload_param,
    });
    return {
      downloadParam,
      // 与参考客户端保持一致：aes_key 为 hex 字符串的 base64 编码。
      aesKeyBase64: Buffer.from(aeskey.toString('hex'), 'utf8').toString('base64'),
      ciphertextSize: filesize,
      plaintextSize: rawsize,
    };
  }
}

/** AES-128-ECB 加密（PKCS7 padding，Node 默认）。 */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** AES-128-ECB 解密（PKCS7 padding，Node 默认）。 */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** AES-128-ECB 密文大小（PKCS7 补齐到 16 字节边界）。 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * 解析 CDNMedia.aes_key（base64）为 16 字节原始 key：
 * - base64(16 raw bytes) 直接用
 * - base64(32 hex chars) 先 ASCII 解码再 hex 解码
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new ILinkError(
    `aes_key 解码异常：${decoded.length} bytes（需要 16 raw bytes 或 32 hex chars）`,
  );
}

function createHashMd5(input: Buffer): string {
  return createHash('md5').update(input).digest('hex');
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
