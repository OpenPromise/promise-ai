import { describe, expect, it } from 'vitest';
import { classifyToolFailure } from './failure-classifier.js';

describe('classifyToolFailure（OpenCrabs 反馈分类思路）', () => {
  it('超时/网络/文件未就绪 = 可恢复，不作为工具缺陷', () => {
    expect(classifyToolFailure('server.shell', '命令执行超时')).toBe('recoverable');
    expect(classifyToolFailure('web.search', 'fetch failed')).toBe('recoverable');
    expect(classifyToolFailure('files.read', '目录不存在：/x')).toBe('recoverable');
    expect(classifyToolFailure('cloud.firewall_list', 'rate limit exceeded')).toBe('recoverable');
  });

  it('参数/实现错误 = 工具缺陷', () => {
    expect(classifyToolFailure('files.list', '参数校验失败：缺少 path')).toBe('defect');
    expect(classifyToolFailure('coding.run', 'TypeError: x is not a function')).toBe('defect');
  });

  it('无法判断 = unknown，留给人工', () => {
    expect(classifyToolFailure('time.get', '发生了一些事情')).toBe('unknown');
  });
});
