import { createDecipheriv } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  aesEcbPaddedSize,
  buildReplyMessage,
  encryptAesEcb,
  extractInboundText,
  ILinkClient,
  ILINK_APP_ID,
  STALE_TOKEN_ERRCODE,
} from './ilink.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ILinkClient headers', () => {
  it('sends app id, version and token auth headers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ret: 0 }));
    const client = new ILinkClient({ token: 'tok-1', channelVersion: '2.4.6', fetchImpl });
    await client.sendMessage(buildReplyMessage({ to: 'wx_user', text: 'hi' }));

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['iLink-App-Id']).toBe(ILINK_APP_ID);
    expect(headers['iLink-App-ClientVersion']).toBe('132102');
    expect(headers.AuthorizationType).toBe('ilink_bot_token');
    expect(headers.Authorization).toBe('Bearer tok-1');
    expect(headers['X-WECHAT-UIN']).toBeTruthy();
  });
});

describe('getUpdates', () => {
  it('parses messages and returns the sync buffer', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ret: 0,
        get_updates_buf: 'buf-2',
        msgs: [
          {
            from_user_id: 'u1',
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: '你好' } }],
          },
        ],
      }),
    );
    const client = new ILinkClient({ token: 't', fetchImpl });
    const resp = await client.getUpdates('buf-1', { timeoutMs: 1000 });
    expect(resp.get_updates_buf).toBe('buf-2');
    expect(resp.msgs?.[0]?.item_list?.[0]?.text_item?.text).toBe('你好');
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.get_updates_buf).toBe('buf-1');
    expect(body.base_info.bot_agent).toBeTruthy();
  });

  it('throws on stale token code', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ret: STALE_TOKEN_ERRCODE, errmsg: 'stale' }),
    );
    const client = new ILinkClient({ token: 't', fetchImpl });
    const resp = await client.getUpdates('', { timeoutMs: 1000 });
    expect(resp.ret).toBe(STALE_TOKEN_ERRCODE);
  });
});

describe('sendMessage', () => {
  it('throws when ret is non-zero', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ret: 1, errmsg: 'boom' }));
    const client = new ILinkClient({ token: 't', fetchImpl });
    await expect(client.sendMessage(buildReplyMessage({ to: 'u', text: 'x' }))).rejects.toThrow(
      /ret=1/,
    );
  });
});

describe('message helpers', () => {
  it('builds a bot text reply message', () => {
    const msg = buildReplyMessage({
      to: 'wx_peer',
      text: '回复',
      contextToken: 'ctx',
      runId: 'r1',
    });
    expect(msg.message_type).toBe(2);
    expect(msg.message_state).toBe(2);
    expect(msg.to_user_id).toBe('wx_peer');
    expect(msg.item_list?.[0]?.text_item?.text).toBe('回复');
    expect(msg.context_token).toBe('ctx');
  });

  it('extracts text and voice transcription from inbound messages', () => {
    expect(extractInboundText({ item_list: [{ type: 1, text_item: { text: '文字' } }] })).toBe(
      '文字',
    );
    expect(extractInboundText({ item_list: [{ type: 3, voice_item: { text: '语音转写' } }] })).toBe(
      '语音转写',
    );
    expect(extractInboundText({ item_list: [{ type: 2 }] })).toBe('');
  });
});

describe('media upload', () => {
  it('encrypts with AES-128-ECB (PKCS7) and pads to 16-byte boundary', () => {
    const key = Buffer.alloc(16, 7);
    const plaintext = Buffer.from('hello weixin media');
    const ciphertext = encryptAesEcb(plaintext, key);
    expect(ciphertext.length).toBe(aesEcbPaddedSize(plaintext.length));
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    expect(decrypted).toEqual(plaintext);
  });

  it('uploads an image end-to-end (getUploadUrl -> CDN -> sendMessage)', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const u = String(input);
      if (u.includes('/getuploadurl')) {
        return jsonResponse({ ret: 0, upload_full_url: 'https://cdn.example/upload' });
      }
      if (u.startsWith('https://cdn.example/')) {
        return new Response('', { status: 200, headers: { 'x-encrypted-param': 'dl-param' } });
      }
      if (u.includes('/sendmessage')) return jsonResponse({ ret: 0 });
      return jsonResponse({});
    });
    const client = new ILinkClient({ token: 't', fetchImpl });
    await client.sendImageToUser({ to: 'wx_user', image: Buffer.from([1, 2, 3]) });

    const calls = fetchImpl.mock.calls as Array<[string, RequestInit]>;
    const sendCall = calls.find(([u]) => u.includes('/sendmessage'))!;
    const body = JSON.parse(sendCall[1].body as string);
    expect(body.msg.to_user_id).toBe('wx_user');
    expect(body.msg.item_list[0].type).toBe(2);
    expect(body.msg.item_list[0].image_item.mid_size).toBe(aesEcbPaddedSize(3));
    expect(body.msg.item_list[0].image_item.media.encrypt_query_param).toBe('dl-param');
    expect(body.msg.item_list[0].image_item.media.encrypt_type).toBe(1);

    const cdnCall = calls.find(([u]) => u.startsWith('https://cdn.example/'))!;
    const headers = cdnCall[1].headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/octet-stream');
    const uploaded = cdnCall[1].body as Uint8Array;
    expect(uploaded.length).toBe(aesEcbPaddedSize(3));
  });

  it('constructs the CDN upload URL from upload_param using the WeChat CDN base', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const u = String(input);
      if (u.includes('/getuploadurl')) return jsonResponse({ ret: 0, upload_param: 'PARAM' });
      if (u.startsWith('https://novac2c.cdn.weixin.qq.com/')) {
        return new Response('', { status: 200, headers: { 'x-encrypted-param': 'dl-param' } });
      }
      if (u.includes('/sendmessage')) return jsonResponse({ ret: 0 });
      return jsonResponse({});
    });
    const client = new ILinkClient({ token: 't', fetchImpl });
    await client.sendImageToUser({ to: 'wx_user', image: Buffer.from([1, 2, 3]) });

    const calls = fetchImpl.mock.calls as Array<[string, RequestInit]>;
    const cdnCall = calls.find(([u]) => u.startsWith('https://novac2c.cdn.weixin.qq.com/'))!;
    expect(cdnCall[0]).toContain('/c2c/upload?encrypted_query_param=PARAM&filekey=');
  });

  it('sends a file as a file_item message', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const u = String(input);
      if (u.includes('/getuploadurl')) {
        return jsonResponse({ ret: 0, upload_full_url: 'https://cdn.example/upload' });
      }
      if (u.startsWith('https://cdn.example/')) {
        return new Response('', { status: 200, headers: { 'x-encrypted-param': 'dl-param' } });
      }
      if (u.includes('/sendmessage')) return jsonResponse({ ret: 0 });
      return jsonResponse({});
    });
    const client = new ILinkClient({ token: 't', fetchImpl });
    await client.sendFileToUser({
      to: 'wx_user',
      file: Buffer.from('pdf-bytes'),
      fileName: '报告.pdf',
    });

    const calls = fetchImpl.mock.calls as Array<[string, RequestInit]>;
    const sendCall = calls.find(([u]) => u.includes('/sendmessage'))!;
    const body = JSON.parse(sendCall[1].body as string);
    expect(body.msg.to_user_id).toBe('wx_user');
    expect(body.msg.item_list[0].type).toBe(4);
    expect(body.msg.item_list[0].file_item.file_name).toBe('报告.pdf');
    expect(body.msg.item_list[0].file_item.len).toBe('9');
    expect(body.msg.item_list[0].file_item.media.encrypt_query_param).toBe('dl-param');
  });

  it('downloads and decrypts inbound CDN media with a raw 16-byte key', async () => {
    const key = Buffer.alloc(16, 3);
    const plain = Buffer.from('plain-image-bytes');
    const encrypted = encryptAesEcb(plain, key);
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const u = String(input);
      expect(u).toContain('/download?encrypted_query_param=PARAM');
      return new Response(new Uint8Array(encrypted), { status: 200 });
    });
    const client = new ILinkClient({ token: 't', fetchImpl });
    const out = await client.downloadMedia({
      encryptQueryParam: 'PARAM',
      aesKeyBase64: key.toString('base64'),
    });
    expect(out).toEqual(plain);
  });

  it('downloads and decrypts with a hex-encoded aes_key', async () => {
    const keyHex = Buffer.alloc(16, 5).toString('hex');
    const plain = Buffer.from('hello');
    const encrypted = encryptAesEcb(plain, Buffer.from(keyHex, 'hex'));
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(encrypted), { status: 200 }));
    const client = new ILinkClient({ token: 't', fetchImpl });
    const out = await client.downloadMedia({
      encryptQueryParam: 'P',
      aesKeyBase64: Buffer.from(keyHex, 'utf8').toString('base64'),
    });
    expect(out).toEqual(plain);
  });
});
