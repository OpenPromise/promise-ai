import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * 文件搜索根解析（N4-P1-1）。
 *
 * 历史实现无条件 `execFileSync('powershell.exe')` 枚举盘符：Linux 容器里必抛
 * ENOENT（还白等一次同步 10s timeout），catch 后静默退化成 `[process.cwd()]`，
 * `/projects`、`/app` 之外的路径全被 filesystem.* 拒绝。这里按平台分流，
 * 并允许用 FILESYSTEM_SEARCH_ROOTS 显式覆盖。
 */
export interface ResolveSearchRootsOptions {
  /** 逗号分隔的显式配置（通常来自 FILESYSTEM_SEARCH_ROOTS）。 */
  configured?: string;
  /** 默认 process.platform，测试注入。 */
  platform?: string;
  /** 默认 process.cwd()，测试注入。 */
  cwd?: string;
  /** Windows 盘符枚举，测试注入；返回 null 表示枚举失败。 */
  listDriveRoots?: () => string[] | null;
  /** 默认 existsSync，测试注入。 */
  exists?: (target: string) => boolean;
}

/** Linux/容器默认根：工作区 + 持久项目目录 + 仓库挂载点。 */
const POSIX_DEFAULT_ROOTS = ['/projects', '/app'];

export function listWindowsDriveRoots(): string[] | null {
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-PSDrive -PSProvider FileSystem).Root'],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
    );
    const roots = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z]:\\$/.test(line));
    return roots.length > 0 ? roots : null;
  } catch {
    return null;
  }
}

export function resolveSearchRoots(options: ResolveSearchRootsOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  // 路径语义跟随目标平台，否则在 Windows 上跑 Linux 分支时 path.resolve
  // 会把 /projects 变成 E:\projects（测试与交叉校验都会失真）。
  const paths = platform === 'win32' ? path.win32 : path.posix;

  // 显式配置优先：即使目录暂不存在也照单全收（部署时可能稍后挂载），
  // 但要去重，避免日志里出现重复根。
  const configured = (options.configured ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => paths.resolve(cwd, entry));
  if (configured.length > 0) return dedupe(configured);

  // Windows 本地开发：枚举盘符（C:\ D:\ …）让文件工具全盘可用
  if (platform === 'win32') {
    const drives = (options.listDriveRoots ?? listWindowsDriveRoots)();
    if (drives && drives.length > 0) return dedupe(drives);
    // 枚举失败：退回工作区，不要把 /projects、/app 这类 POSIX 路径
    // path.resolve 成当前盘的 E:\projects、E:\app（既非预期也可能误开放）。
    return [paths.resolve(cwd)];
  }

  // Linux/容器：工作区 + 默认根，只保留真实存在的目录。
  // 容器里 WORKDIR 就是 /app，所以 cwd 常与默认根重合——必须去重。
  return dedupe([paths.resolve(cwd), ...POSIX_DEFAULT_ROOTS]).filter((entry) => exists(entry));
}

function dedupe(roots: string[]): string[] {
  return [...new Set(roots)];
}
