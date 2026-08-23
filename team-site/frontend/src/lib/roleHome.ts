/**
 * 角色个人主页前端兜底映射。
 *
 * 后端 /api/roles 当前不返回 homeUrl/homeStatus（不动后端 API 契约），
 * 前端按角色 id 兜底补齐；字段取值与 api/client.ts 的 FALLBACK_ROLES 保持一致。
 * 小夜主页（/xiaoye）已上线，homeStatus 为 live——渲染为不可点「建设中」徽章，
 * 不产生 href，杜绝 404 入口；上线后改为 live 并注册 nginx 路由即可。
 */
import type { Role, RoleHomeStatus } from '../api/client';

interface RoleHome {
  homeUrl: string;
  homeStatus: RoleHomeStatus;
}

const ROLE_HOME_MAP: Record<string, RoleHome> = {
  xiaohei: { homeUrl: '/xiaohei', homeStatus: 'live' },
  xiaoyou: { homeUrl: '/xiaoyou', homeStatus: 'live' },
  xiaoye: { homeUrl: '/xiaoye', homeStatus: 'live' },
};

export function resolveRoleHome(
  role: Role,
): { homeUrl: string; homeStatus: RoleHomeStatus } | null {
  if (role.homeUrl && role.homeStatus) {
    return { homeUrl: role.homeUrl, homeStatus: role.homeStatus };
  }
  const fallback = ROLE_HOME_MAP[role.id];
  return fallback ?? null;
}
