import { describe, expect, it, vi } from 'vitest';
import {
  buildReplyMessage,
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
