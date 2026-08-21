import { describe, expect, it } from 'vitest';
import { checkBridgeAuth, isBridgeAuthExemptPath } from './auth.js';

describe('isBridgeAuthExemptPath', () => {
  it('探活与扫码登录链路免鉴权（浏览器扫码时还没有共享密钥可用）', () => {
    expect(isBridgeAuthExemptPath('/health')).toBe(true);
    expect(isBridgeAuthExemptPath('/weixin/login')).toBe(true);
    expect(isBridgeAuthExemptPath('/api/weixin/login')).toBe(true);
    expect(isBridgeAuthExemptPath('/api/weixin/login/abc123')).toBe(true);
    expect(isBridgeAuthExemptPath('/api/weixin/login/abc123/verify')).toBe(true);
    expect(isBridgeAuthExemptPath('/health?probe=1')).toBe(true);
  });

  it('动作/数据端点一律需要鉴权（含 status：会泄漏登录态与对端数量）', () => {
    for (const path of [
      '/api/weixin/status',
      '/api/weixin/logout',
      '/api/weixin/send-image',
      '/api/weixin/send-file',
      '/api/weixin/send-file-async',
      '/api/weixin/files',
      '/api/weixin/delete-file',
      '/api/weixin/jobs',
      '/api/weixin/jobs/j1',
    ]) {
      expect(isBridgeAuthExemptPath(path), path).toBe(false);
    }
  });

  it('前缀绕过无效', () => {
    expect(isBridgeAuthExemptPath('/healthz')).toBe(false);
    expect(isBridgeAuthExemptPath('/api/weixin/loginx')).toBe(false);
    expect(isBridgeAuthExemptPath('/weixin/loginx')).toBe(false);
    expect(isBridgeAuthExemptPath('/api/weixin/login/../logout')).toBe(false);
  });
});

describe('checkBridgeAuth', () => {
  it('免鉴权路径直接放行，不看头也不看是否配置了 token', () => {
    expect(checkBridgeAuth({ url: '/health', headers: {}, token: undefined }).ok).toBe(true);
    expect(checkBridgeAuth({ url: '/api/weixin/login', headers: {}, token: 'tok' }).ok).toBe(true);
  });

  it('未配置 BRIDGE_TOKEN 时受保护端点一律拒绝（不允许裸奔）', () => {
    const result = checkBridgeAuth({ url: '/api/weixin/files', headers: {}, token: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toContain('BRIDGE_TOKEN');
    }
  });

  it('配置后校验 x-bridge-token（也接受 Authorization: Bearer）', () => {
    expect(
      checkBridgeAuth({
        url: '/api/weixin/files',
        headers: { 'x-bridge-token': 'tok' },
        token: 'tok',
      }).ok,
    ).toBe(true);
    expect(
      checkBridgeAuth({
        url: '/api/weixin/files',
        headers: { authorization: 'Bearer tok' },
        token: 'tok',
      }).ok,
    ).toBe(true);

    const missing = checkBridgeAuth({ url: '/api/weixin/files', headers: {}, token: 'tok' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(401);

    const wrong = checkBridgeAuth({
      url: '/api/weixin/files',
      headers: { 'x-bridge-token': 'nope' },
      token: 'tok',
    });
    expect(wrong.ok).toBe(false);

    // 长度不同也不能因为恒定时间比较而抛错
    const shorter = checkBridgeAuth({
      url: '/api/weixin/files',
      headers: { 'x-bridge-token': 'n' },
      token: 'tok',
    });
    expect(shorter.ok).toBe(false);
  });
});
