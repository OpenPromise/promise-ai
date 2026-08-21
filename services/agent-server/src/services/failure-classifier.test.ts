import { describe, expect, it } from 'vitest';
import { classifyToolFailure } from './failure-classifier.js';

describe('classifyToolFailure（OpenCrabs 反馈分类思路）', () => {
  it('结构化环境信号 = 可恢复，不作为工具缺陷', () => {
    expect(classifyToolFailure('server.shell', '命令执行超时')).toBe('recoverable');
    expect(classifyToolFailure('web.search', 'fetch failed')).toBe('recoverable');
    expect(classifyToolFailure('cloud.firewall_list', 'rate limit exceeded')).toBe('recoverable');
    expect(classifyToolFailure('web.fetch', '抓取失败：connect ETIMEDOUT 1.2.3.4:443')).toBe(
      'recoverable',
    );
    expect(classifyToolFailure('web.fetch', 'ECONNRESET')).toBe('recoverable');
    expect(classifyToolFailure('web.fetch', '抓取失败：HTTP 503')).toBe('recoverable');
    expect(classifyToolFailure('web.fetch', '抓取失败：HTTP 429 Too Many Requests')).toBe(
      'recoverable',
    );
    expect(classifyToolFailure('coding.run', 'AbortError: The operation was aborted')).toBe(
      'recoverable',
    );
    expect(classifyToolFailure('server.shell', '工具执行被取消')).toBe('recoverable');
  });

  it('参数/实现错误 = 工具缺陷', () => {
    expect(classifyToolFailure('files.list', '参数校验失败：缺少 path')).toBe('defect');
    expect(classifyToolFailure('coding.run', 'TypeError: x is not a function')).toBe('defect');
    expect(classifyToolFailure('coding.run', 'SyntaxError: Unexpected token }')).toBe('defect');
    expect(classifyToolFailure('files.read', 'ReferenceError: foo is not defined')).toBe('defect');
  });

  it('路径/文件不存在 = 缺陷（模型传错路径），不是环境抖动', () => {
    expect(classifyToolFailure('files.read', '目录不存在：/x')).toBe('defect');
    expect(
      classifyToolFailure('files.read', "ENOENT: no such file or directory, open '/tmp/x'"),
    ).toBe('defect');
  });

  it('确定性缺陷带「请稍后重试」措辞时仍判缺陷（先判缺陷）', () => {
    expect(classifyToolFailure('files.list', '参数 path 非法，请稍后重试')).toBe('defect');
    expect(
      classifyToolFailure('coding.run', "TypeError: Cannot read properties of undefined，请稍后再试"),
    ).toBe('defect');
  });

  it('仅靠自然语言措辞不再判可恢复（避免万能后缀吃掉真缺陷）', () => {
    expect(classifyToolFailure('server.shell', '操作失败，请稍后重试')).toBe('unknown');
    expect(classifyToolFailure('server.shell', '暂时无法完成')).toBe('unknown');
  });

  it('「参数」二字出现在说明性文字里不算缺陷', () => {
    expect(classifyToolFailure('files.list', '工具说明：参数 path 表示目录')).toBe('unknown');
  });

  it('无法判断 = unknown，留给人工', () => {
    expect(classifyToolFailure('time.get', '发生了一些事情')).toBe('unknown');
  });
});
