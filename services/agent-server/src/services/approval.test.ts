import { describe, expect, it } from 'vitest';
import { ApprovalRegistry } from './approval.js';

describe('ApprovalRegistry request-scoped grants', () => {
  it('remembers and clears per-request fingerprint grants（N4-P2-1）', () => {
    const registry = new ApprovalRegistry();
    const fp = 'app.launch|{"url":"x"}';
    expect(registry.isRequestApproved('req-1', fp)).toBe(false);

    registry.rememberRequestApproval('req-1', 's1', fp);
    expect(registry.isRequestApproved('req-1', fp)).toBe(true);
    // 同名工具不同参数（不同指纹）、其他请求、无请求 id 都不受影响。
    expect(registry.isRequestApproved('req-1', 'app.launch|{"url":"y"}')).toBe(false);
    expect(registry.isRequestApproved('req-2', fp)).toBe(false);
    expect(registry.isRequestApproved(undefined, fp)).toBe(false);

    registry.clearForRequest('req-1');
    expect(registry.isRequestApproved('req-1', fp)).toBe(false);
  });

  it('clearForSession 清理该会话在途请求的任务级授权（N4-P2-2）', () => {
    const registry = new ApprovalRegistry();
    const fp = 'server.shell|{"command":"ls"}';
    registry.rememberRequestApproval('req-a', 's1', fp);
    registry.rememberRequestApproval('req-b', 's2', fp);
    registry.clearForSession('s1');
    expect(registry.isRequestApproved('req-a', fp)).toBe(false);
    // 其它会话的授权不受影响
    expect(registry.isRequestApproved('req-b', fp)).toBe(true);
  });

  /**
   * 归属会话与指纹集合存在同一条记录里，驱逐时不可能只删一半。
   * 说明：早前的两表实现（#requestApproved / #requestSession）在 LRU 驱逐后
   * 会留下无上限的陈旧归属记录，但那是纯内存泄漏、公开 API 观测不到，
   * 因此本用例锁的是"驱逐 + 重新授权后按归属清理仍正确"这一可观测行为，
   * 泄漏本身由单条记录的结构保证（而非本用例）消除。
   */
  it('驱逐并重新授权后，clearForSession 仍按归属精确清理', () => {
    const registry = new ApprovalRegistry();
    const fp = 'server.shell|{"command":"ls"}';
    registry.rememberRequestApproval('req-evicted', 's-old', fp);
    // 灌满上限，把 req-evicted 挤出去
    for (let i = 0; i < 200; i += 1) {
      registry.rememberRequestApproval(`req-filler-${i}`, 's-filler', fp);
    }
    expect(registry.isRequestApproved('req-evicted', fp)).toBe(false);

    // 同一个 requestId 在新会话下重新获批：归属必须跟着换成新会话
    registry.rememberRequestApproval('req-evicted', 's-new', fp);
    registry.clearForSession('s-old');
    expect(registry.isRequestApproved('req-evicted', fp)).toBe(true);
    registry.clearForSession('s-new');
    expect(registry.isRequestApproved('req-evicted', fp)).toBe(false);
  });
});

describe('ApprovalRequest.expiresAt', () => {
  it('携带服务端过期时刻（createdAt + 超时窗口），供下游通道按它计时', () => {
    const registry = new ApprovalRegistry({ timeoutMs: 30_000 });
    const { request } = registry.request({
      sessionId: 's1',
      toolName: 'files.delete',
      arguments: { path: '/tmp/x' },
      permissionLevel: 2,
      confirmationsNeeded: 1,
    });

    expect(Date.parse(request.expiresAt) - Date.parse(request.createdAt)).toBe(30_000);
    // listPending 返回的同一份请求也带 expiresAt（SSE/桥接侧读的就是它）。
    expect(registry.listPending('s1')[0]?.expiresAt).toBe(request.expiresAt);

    registry.clearForSession('s1');
  });
});

describe('ApprovalRegistry.respond 归属校验（N-P0-3）', () => {
  it('requestId 属于别的会话时拒绝作答，原请求仍待处理', () => {
    const registry = new ApprovalRegistry({ timeoutMs: 30_000 });
    const { request } = registry.request({
      sessionId: 's-owner',
      toolName: 'files.delete',
      arguments: { path: '/tmp/x' },
      permissionLevel: 2,
      confirmationsNeeded: 1,
    });

    // 冒充其他会话作答：既不放行也不消费该请求
    expect(registry.respond(request.requestId, { approved: true }, 's-attacker')).toBe('forbidden');
    expect(registry.listPending('s-owner')).toHaveLength(1);

    // 归属会话作答才生效
    expect(registry.respond(request.requestId, { approved: true }, 's-owner')).toBe('resolved');
    expect(registry.listPending('s-owner')).toHaveLength(0);

    // 未知/已过期请求：not_found（与"归属不符"区分开，路由分别回 404 / 403）
    expect(registry.respond('no-such-request', { approved: true }, 's-owner')).toBe('not_found');

    registry.clearForSession('s-owner');
  });

  it('不传 sessionId 时按内部调用处理（语音通道等已在同一会话上下文内）', () => {
    const registry = new ApprovalRegistry({ timeoutMs: 30_000 });
    const { request } = registry.request({
      sessionId: 's-internal',
      toolName: 'app.launch',
      arguments: {},
      permissionLevel: 2,
      confirmationsNeeded: 1,
    });
    expect(registry.respond(request.requestId, { approved: false })).toBe('resolved');
  });
});

describe('ApprovalRegistry 有界指纹记忆', () => {
  it('每会话指纹数与会话总数封顶，最旧记录被驱逐', () => {
    const registry = new ApprovalRegistry({ timeoutMs: 30_000 });
    // 同一会话超过单会话指纹上限：最早记住的指纹被驱逐
    for (let i = 0; i < 105; i += 1) {
      registry.rememberApproval('s-fp', `tool.${i}`);
    }
    expect(registry.isApproved('s-fp', 'tool.0')).toBe(false);
    expect(registry.isApproved('s-fp', 'tool.104')).toBe(true);
  });

  // N-P1-6：clearForRequest 走不到的异常路径（流被中断、语音连接异常断开）
  // 会留下永久条目，这里必须有上限驱逐。
  it('任务级授权（#requestApproved）同样封顶：请求数与单请求工具数都驱逐最旧', () => {
    const registry = new ApprovalRegistry({ timeoutMs: 30_000 });
    for (let i = 0; i < 205; i += 1) {
      registry.rememberRequestApproval(`req-${i}`, 's1', 'server.shell|{"cmd":"x"}');
    }
    expect(registry.isRequestApproved('req-0', 'server.shell|{"cmd":"x"}')).toBe(false);
    expect(registry.isRequestApproved('req-204', 'server.shell|{"cmd":"x"}')).toBe(true);

    for (let i = 0; i < 105; i += 1) {
      registry.rememberRequestApproval('req-many-tools', 's1', `tool.${i}|{}`);
    }
    expect(registry.isRequestApproved('req-many-tools', 'tool.0|{}')).toBe(false);
    expect(registry.isRequestApproved('req-many-tools', 'tool.104|{}')).toBe(true);
  });
});
