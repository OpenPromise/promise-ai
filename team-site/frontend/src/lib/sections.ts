/**
 * 全屏板块注册表：单页 scroll-snap 翻页（对齐参考站 wrapSwiper 五板块）。
 * 旧路由路径（/news 等）、hash（#news）与 ?nav=N 均映射到板块，保持旧链接可用。
 */

export interface SectionDef {
  /** DOM id（也作 hash 深链：#news） */
  id: string;
  /** 旧路由路径（保留兼容，直接访问时定位到对应板块） */
  path: string;
  /** 顶栏文字 */
  label: string;
  /** 参考站 nav 序号（1 起） */
  index: number;
}

export const SECTIONS: SectionDef[] = [
  { id: 'home', path: '/', label: '首页', index: 1 },
  { id: 'news', path: '/news', label: '情报速递', index: 2 },
  { id: 'roles', path: '/roles', label: '角色介绍', index: 3 },
  { id: 'world', path: '/world', label: '世界全景', index: 4 },
  { id: 'city', path: '/city', label: '都市映像', index: 5 },
];

export function scrollToSection(id: string, behavior: ScrollBehavior = 'smooth') {
  document.getElementById(id)?.scrollIntoView({ behavior, block: 'start' });
}

/** 解析进入地址 → 目标板块（hash > 旧路径 > ?nav=N > 首页） */
export function resolveInitialSection(): string {
  if (typeof window === 'undefined') return 'home'; // SSR/无 window 环境安全兜底
  const { hash, pathname, search } = window.location;
  if (hash) {
    const found = SECTIONS.find((s) => `#${s.id}` === hash.toLowerCase());
    if (found) return found.id;
  }
  if (pathname !== '/') {
    const found = SECTIONS.find((s) => s.path === pathname);
    if (found) return found.id;
  }
  const nav = Number(new URLSearchParams(search).get('nav'));
  if (Number.isFinite(nav)) {
    const found = SECTIONS.find((s) => s.index === nav);
    if (found) return found.id;
  }
  return 'home';
}

/** 同步 URL 深链（不触发滚动） */
export function syncHash(id: string) {
  const target = `#${id}`;
  if (window.location.hash !== target) {
    history.replaceState(null, '', target);
  }
}
