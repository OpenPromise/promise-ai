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
