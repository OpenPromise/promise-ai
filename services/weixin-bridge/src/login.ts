import { randomUUID } from 'node:crypto';
import type { ILinkClient, QrStatus } from './ilink.js';

export interface ActiveLogin {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  pendingVerifyCode?: string;
  status: QrStatus;
  error?: string;
  /** 服务端要求重定向到的新 host。 */
  redirectHost?: string;
}

const LOGIN_TTL_MS = 5 * 60_000;

export class LoginManager {
  readonly #logins = new Map<string, ActiveLogin>();
  readonly #client: ILinkClient;
  readonly #localTokenList: () => string[];

  constructor(options: { client: ILinkClient; localTokenList: () => string[] }) {
    this.#client = options.client;
    this.#localTokenList = options.localTokenList;
  }

  async start(): Promise<ActiveLogin> {
    this.#purgeExpired();
    const qr = await this.#client.fetchQrCode(this.#localTokenList());
    const login: ActiveLogin = {
      sessionKey: randomUUID(),
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcode_img_content,
      startedAt: Date.now(),
      status: 'wait',
    };
    this.#logins.set(login.sessionKey, login);
    return login;
  }

  /** 执行一次长轮询（最多 35s），返回最新状态；confirmed 时返回凭证。 */
  async poll(sessionKey: string): Promise<{
    status: QrStatus;
    botToken?: string;
    accountId?: string;
    userId?: string;
    baseUrl?: string;
    error?: string;
  }> {
    const login = this.#logins.get(sessionKey);
    if (!login) return { status: 'expired', error: '登录会话不存在或已过期' };
    if (Date.now() - login.startedAt > LOGIN_TTL_MS) {
      this.#logins.delete(sessionKey);
      return { status: 'expired', error: '二维码已过期，请重新生成' };
    }

    const baseUrl = login.redirectHost ? `https://${login.redirectHost}` : this.#client.baseUrl;
    const resp = await this.#client.pollQrStatus(
      login.qrcode,
      login.pendingVerifyCode,
      undefined,
      baseUrl,
    );

    login.status = resp.status;
    if (resp.status === 'scaned_but_redirect' && resp.redirect_host) {
      login.redirectHost = resp.redirect_host;
    }
    if (resp.status === 'confirmed') {
      this.#logins.delete(sessionKey);
      return {
        status: 'confirmed',
        botToken: resp.bot_token,
        accountId: resp.ilink_bot_id,
        userId: resp.ilink_user_id,
        baseUrl: resp.baseurl || this.#client.baseUrl,
      };
    }
    // 轮询连续失败到上限：把故障透出去，让登录页显示错误而不是"等待扫码"（P1-19）。
    if (resp.status === 'error') {
      login.error = resp.message;
      return { status: 'error', error: resp.message ?? '二维码状态查询失败' };
    }
    return { status: resp.status };
  }

  async setVerifyCode(sessionKey: string, code: string): Promise<void> {
    const login = this.#logins.get(sessionKey);
    if (login) login.pendingVerifyCode = code.trim();
  }

  #purgeExpired(): void {
    const now = Date.now();
    for (const [key, login] of this.#logins) {
      if (now - login.startedAt > LOGIN_TTL_MS) this.#logins.delete(key);
    }
  }
}
