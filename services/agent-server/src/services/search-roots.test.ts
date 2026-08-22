import { describe, expect, it } from 'vitest';
import { resolveSearchRoots } from './search-roots.js';

/**
 * N4-P1-1：历史实现无条件 exec powershell 枚举盘符，Linux 容器里必失败并
 * 静默退化成 [cwd]，同时白等一次 10s 同步 timeout。这些用例锁住修复后的行为。
 */
describe('resolveSearchRoots（N4-P1-1）', () => {
  const neverCalled = (): string[] | null => {
    throw new Error('Linux 下不应枚举盘符（powershell 必失败且同步阻塞 10s）');
  };

  it('Linux 容器：默认 [cwd, /projects, /app]，且不 exec powershell', () => {
    const roots = resolveSearchRoots({
      platform: 'linux',
      cwd: '/workspace',
      listDriveRoots: neverCalled,
      exists: () => true,
    });
    expect(roots).toEqual(['/workspace', '/projects', '/app']);
  });

  it('容器内 cwd 就是 /app 时去重（避免 [/app, /projects, /app]）', () => {
    const roots = resolveSearchRoots({
      platform: 'linux',
      cwd: '/app',
      listDriveRoots: neverCalled,
      exists: () => true,
    });
    expect(roots).toEqual(['/app', '/projects']);
  });

  it('只保留真实存在的默认根（宿主机没挂 /projects 时不列入）', () => {
    const roots = resolveSearchRoots({
      platform: 'linux',
      cwd: '/app',
      listDriveRoots: neverCalled,
      exists: (target) => target !== '/projects',
    });
    expect(roots).toEqual(['/app']);
  });

  it('FILESYSTEM_SEARCH_ROOTS 显式配置优先，去重且不 exec powershell', () => {
    const roots = resolveSearchRoots({
      configured: ' /srv/a , /srv/b ,, /srv/a ',
      platform: 'linux',
      cwd: '/app',
      listDriveRoots: neverCalled,
      // 显式配置即使暂不存在也保留（部署时可能稍后挂载）
      exists: () => false,
    });
    expect(roots).toEqual(['/srv/a', '/srv/b']);
  });

  it('Windows：盘符枚举成功时用盘符根', () => {
    const roots = resolveSearchRoots({
      platform: 'win32',
      cwd: 'E:\\Promise_ai',
      listDriveRoots: () => ['C:\\', 'E:\\'],
      exists: () => true,
    });
    expect(roots).toEqual(['C:\\', 'E:\\']);
  });

  it('Windows 枚举失败时退回工作区，不把 /projects 解析成当前盘目录', () => {
    const roots = resolveSearchRoots({
      platform: 'win32',
      cwd: 'E:\\Promise_ai',
      listDriveRoots: () => null,
      exists: () => true,
    });
    expect(roots).toEqual(['E:\\Promise_ai']);
    expect(roots.some((root) => /projects|app$/i.test(root))).toBe(false);
  });
});
