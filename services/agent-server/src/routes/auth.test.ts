import { describe, expect, it } from 'vitest';
import { extractApiToken, isAuthExemptPath, resolveApiAuthMode } from './auth.js';

describe('isAuthExemptPath', () => {
  it('/health 与 /api/hooks/* 豁免（探活 + hooks 有自己的 HOOK_SECRET）', () => {
    expect(isAuthExemptPath('/health')).toBe(true);
    expect(isAuthExemptPath('/health?probe=1')).toBe(true);
    expect(isAuthExemptPath('/api/hooks/github')).toBe(true);
    expect(isAuthExemptPath('/api/hooks/alert?x=1')).toBe(true);
  });

  it('静态欢迎页豁免（浏览器直接打开，无数据无副作用）', () => {
    expect(isAuthExemptPath('/xiaohei')).toBe(true);
  });

  it('会话/聊天/审批/事件/语音一律不豁免', () => {
    expect(isAuthExemptPath('/api/sessions')).toBe(false);
    expect(isAuthExemptPath('/api/sessions/abc/chat')).toBe(false);
    expect(isAuthExemptPath('/api/sessions/abc/permission')).toBe(false);
    expect(isAuthExemptPath('/api/events')).toBe(false);
    expect(isAuthExemptPath('/ws/voice/abc')).toBe(false);
  });

  it('前缀绕过无效：/healthz、/api/hooksx 不是豁免路径', () => {
    expect(isAuthExemptPath('/healthz')).toBe(false);
    expect(isAuthExemptPath('/api/hooksx/github')).toBe(false);
    expect(isAuthExemptPath('/xiaohei/../api/sessions')).toBe(false);
  });
});

describe('extractApiToken', () => {
  it('支持 Authorization: Bearer 与 x-agent-token 两种头', () => {
    expect(extractApiToken({ authorization: 'Bearer tok-1' })).toBe('tok-1');
    expect(extractApiToken({ authorization: 'bearer tok-1' })).toBe('tok-1');
    expect(extractApiToken({ 'x-agent-token': 'tok-2' })).toBe('tok-2');
  });

  it('缺失/格式不对时返回 undefined', () => {
    expect(extractApiToken({})).toBeUndefined();
    expect(extractApiToken({ authorization: 'Basic abc' })).toBeUndefined();
    expect(extractApiToken({ authorization: 'Bearer   ' })).toBeUndefined();
    expect(extractApiToken({ 'x-agent-token': ['a', 'b'] })).toBeUndefined();
  });
});

describe('resolveApiAuthMode', () => {
  it('配置了 token：任何环境都强制校验', () => {
    expect(resolveApiAuthMode('tok', 'production')).toBe('token');
    expect(resolveApiAuthMode('tok', 'development')).toBe('token');
    expect(resolveApiAuthMode('tok', 'test')).toBe('token');
  });

  it('生产环境未配置 token：一律拒绝（fail closed，不允许裸奔）', () => {
    expect(resolveApiAuthMode(undefined, 'production')).toBe('closed');
  });

  it('开发/测试未配置 token：放行（不误伤本地开发与仓库测试）', () => {
    expect(resolveApiAuthMode(undefined, 'development')).toBe('open');
    expect(resolveApiAuthMode(undefined, 'test')).toBe('open');
  });
});
