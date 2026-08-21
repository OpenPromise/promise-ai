import { describe, expect, it } from 'vitest';
import { ApprovalRegistry } from './approval.js';

describe('ApprovalRegistry request-scoped grants', () => {
  it('remembers and clears per-request tool grants', () => {
    const registry = new ApprovalRegistry();
    expect(registry.isRequestApproved('req-1', 'app.launch')).toBe(false);

    registry.rememberRequestApproval('req-1', 'app.launch');
    expect(registry.isRequestApproved('req-1', 'app.launch')).toBe(true);
    // 其他工具、其他请求、无请求 id 都不受影响。
    expect(registry.isRequestApproved('req-1', 'terminal.run')).toBe(false);
    expect(registry.isRequestApproved('req-2', 'app.launch')).toBe(false);
    expect(registry.isRequestApproved(undefined, 'app.launch')).toBe(false);

    registry.clearForRequest('req-1');
    expect(registry.isRequestApproved('req-1', 'app.launch')).toBe(false);
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
