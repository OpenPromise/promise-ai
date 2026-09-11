import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export interface Skill {
  /** Frontmatter name (stable id for allowlists). */
  name: string;
  description: string;
  /** Markdown body after frontmatter. */
  body: string;
  /** Absolute directory containing SKILL.md. */
  dir: string;
}

export interface LoadSkillsForRoleOptions {
  /** Repo root: discovers `skills/` and `{role}/skills/`. */
  projectRoot: string;
  /** Colleague id / role key, e.g. xiaozhen. */
  role: string;
  /** role → skill name allowlist. Defaults to DEFAULT_ROLE_SKILL_ALLOWLIST. */
  allowlist?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Explicit role → skill-name allowlist. Missing role ⇒ no skills injected.
 * Keep this small; retrieval can come later.
 */
export const DEFAULT_ROLE_SKILL_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  xiaozhen: ['release-smoke'],
  xiaoyou: ['host-health'],
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse a SKILL.md: YAML-ish frontmatter (name / description only) + markdown body.
 * Returns null when name cannot be resolved or file is empty.
 */
export function parseSkillMd(content: string, dir = ''): Skill | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const match = FRONTMATTER_RE.exec(trimmed);
  let name = '';
  let description = '';
  let body = trimmed;

  if (match) {
    const fm = match[1] ?? '';
    body = (match[2] ?? '').trim();
    for (const line of fm.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const key = m[1]?.toLowerCase();
      const value = stripQuotes((m[2] ?? '').trim());
      if (key === 'name') name = value;
      else if (key === 'description') description = value;
    }
  }

  if (!name) {
    // Fallback: folder basename when frontmatter omits name.
    name = path.basename(dir || '');
  }
  if (!name) return null;

  return { name, description, body, dir };
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Roots to scan for skill folders: `skills/` + `{role}/skills/`. */
export function skillRootsForRole(projectRoot: string, role: string): string[] {
  const root = path.resolve(projectRoot);
  const roots = [path.join(root, 'skills')];
  if (role) roots.push(path.join(root, role, 'skills'));
  return roots;
}

/**
 * Discover skills under each root. Layout: `{root}/{skillName}/SKILL.md`.
 * Missing roots are skipped. Duplicate names: later roots win.
 */
export async function discoverSkills(roots: readonly string[]): Promise<Skill[]> {
  const byName = new Map<string, Skill>();

  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    for (const entry of entries) {
      const skillDir = path.join(root, entry);
      let isDir = false;
      try {
        isDir = (await stat(skillDir)).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;

      const skillFile = path.join(skillDir, 'SKILL.md');
      let content: string;
      try {
        content = await readFile(skillFile, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }

      const skill = parseSkillMd(content, skillDir);
      if (!skill) continue;
      byName.set(skill.name, skill);
    }
  }

  return [...byName.values()];
}

/** Filter discovered skills by the role allowlist (order follows allowlist). */
export function selectSkillsForRole(
  skills: readonly Skill[],
  role: string,
  allowlist: Readonly<Record<string, readonly string[]>> = DEFAULT_ROLE_SKILL_ALLOWLIST,
): Skill[] {
  const names = allowlist[role];
  if (!names || names.length === 0) return [];
  const byName = new Map(skills.map((s) => [s.name, s]));
  const selected: Skill[] = [];
  for (const name of names) {
    const skill = byName.get(name);
    if (skill) selected.push(skill);
  }
  return selected;
}

/** Discover + filter for one role. Missing dirs / skills are skipped. */
export async function loadSkillsForRole(options: LoadSkillsForRoleOptions): Promise<Skill[]> {
  const roots = skillRootsForRole(options.projectRoot, options.role);
  const discovered = await discoverSkills(roots);
  return selectSkillsForRole(discovered, options.role, options.allowlist);
}

/** Format skills as a system-prompt section (empty string when none). */
export function formatSkillsSection(skills: readonly Skill[]): string {
  if (skills.length === 0) return '';
  const blocks = skills.map((skill) => {
    const title = skill.description
      ? `### ${skill.name} — ${skill.description}`
      : `### ${skill.name}`;
    return `${title}\n${skill.body}`.trim();
  });
  return `## Skills\n\n以下是与你岗位相关的技能手册，按需遵循：\n\n${blocks.join('\n\n')}`;
}

/** Append skills section to a base colleague prompt. No-op when skills empty. */
export function injectSkillsIntoPrompt(basePrompt: string, skills: readonly Skill[]): string {
  const section = formatSkillsSection(skills);
  if (!section) return basePrompt;
  const base = basePrompt.trimEnd();
  return `${base}\n\n${section}`;
}
