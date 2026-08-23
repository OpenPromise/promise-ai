export interface SectionDef {
  id: string;
  path: string;
  label: string;
  index: number;
  aliases?: string[];
}

export const SECTIONS: SectionDef[] = [
  { id: 'home', path: '/', label: '首页', index: 1 },
  { id: 'signals', path: '/news', label: '情报', index: 2, aliases: ['news'] },
  { id: 'team', path: '/roles', label: '团队', index: 3, aliases: ['roles'] },
  { id: 'system', path: '/system', label: '工作方式', index: 4 },
  { id: 'world', path: '/world', label: '世界', index: 5 },
  { id: 'next', path: '/city', label: '下一步', index: 6, aliases: ['city'] },
];

const aliases = new Map<string, string>();
for (const section of SECTIONS) {
  aliases.set(section.id, section.id);
  section.aliases?.forEach((alias) => aliases.set(alias, section.id));
}

export function canonicalSection(id: string): string {
  return aliases.get(id.toLowerCase()) ?? 'home';
}

export function scrollToSection(id: string, behavior: ScrollBehavior = 'smooth') {
  const finalBehavior =
    behavior === 'smooth' &&
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : behavior;
  document.getElementById(canonicalSection(id))?.scrollIntoView({
    behavior: finalBehavior,
    block: 'start',
  });
}

export function resolveInitialSection(): string {
  if (typeof window === 'undefined') return 'home';
  const { hash, pathname, search } = window.location;
  if (hash) return canonicalSection(hash.slice(1));
  const direct = SECTIONS.find((s) => s.path === pathname);
  if (direct) return direct.id;
  const legacy = SECTIONS.find((s) => s.aliases?.includes(pathname.slice(1)));
  if (legacy) return legacy.id;
  const nav = Number(new URLSearchParams(search).get('nav'));
  if (Number.isFinite(nav)) {
    return SECTIONS.find((s) => s.index === nav)?.id ?? 'home';
  }
  return 'home';
}

export function syncHash(id: string) {
  const target = `#${canonicalSection(id)}`;
  if (window.location.hash !== target) history.replaceState(null, '', target);
}
