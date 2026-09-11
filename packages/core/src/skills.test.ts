import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverSkills,
  injectSkillsIntoPrompt,
  loadSkillsForRole,
  parseSkillMd,
  selectSkillsForRole,
} from './skills.js';

const tempDirs: string[] = [];

async function createTempRoot(
  layout: Record<string, string>,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'skills-test-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('parseSkillMd', () => {
  it('parses frontmatter name/description and body', () => {
    const skill = parseSkillMd(
      `---
name: release-smoke
description: QA smoke checklist
---

# Checklist
- typecheck
`,
      '/tmp/release-smoke',
    );
    expect(skill).toEqual({
      name: 'release-smoke',
      description: 'QA smoke checklist',
      body: '# Checklist\n- typecheck',
      dir: '/tmp/release-smoke',
    });
  });

  it('falls back to folder name when frontmatter omits name', () => {
    const skill = parseSkillMd('Just a body', '/skills/host-health');
    expect(skill?.name).toBe('host-health');
    expect(skill?.body).toBe('Just a body');
  });

  it('returns null for empty content', () => {
    expect(parseSkillMd('   ')).toBeNull();
  });

  it('strips quoted frontmatter values', () => {
    const skill = parseSkillMd(
      `---
name: "quoted-name"
description: 'quoted desc'
---
body
`,
    );
    expect(skill?.name).toBe('quoted-name');
    expect(skill?.description).toBe('quoted desc');
  });
});

describe('discoverSkills + selectSkillsForRole', () => {
  it('discovers skills from skills/ and {role}/skills/', async () => {
    const root = await createTempRoot({
      'skills/shared-note/SKILL.md': `---
name: shared-note
description: shared
---
shared body
`,
      'xiaozhen/skills/release-smoke/SKILL.md': `---
name: release-smoke
description: smoke
---
qa body
`,
      'xiaoyou/skills/host-health/SKILL.md': `---
name: host-health
description: health
---
ops body
`,
    });

    const forQa = await discoverSkills([
      path.join(root, 'skills'),
      path.join(root, 'xiaozhen', 'skills'),
    ]);
    expect(forQa.map((s) => s.name).sort()).toEqual(['release-smoke', 'shared-note']);

    const selected = selectSkillsForRole(forQa, 'xiaozhen', {
      xiaozhen: ['release-smoke', 'shared-note', 'missing'],
    });
    expect(selected.map((s) => s.name)).toEqual(['release-smoke', 'shared-note']);
  });

  it('skips missing roots and folders without SKILL.md', async () => {
    const root = await createTempRoot({
      'skills/empty-dir/.keep': '',
      'skills/good/SKILL.md': `---
name: good
---
ok
`,
    });
    const skills = await discoverSkills([
      path.join(root, 'skills'),
      path.join(root, 'nope'),
    ]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('good');
  });

  it('later roots override duplicate skill names', async () => {
    const root = await createTempRoot({
      'skills/dup/SKILL.md': `---
name: dup
---
from shared
`,
      'xiaozhen/skills/dup/SKILL.md': `---
name: dup
---
from role
`,
    });
    const skills = await discoverSkills([
      path.join(root, 'skills'),
      path.join(root, 'xiaozhen', 'skills'),
    ]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.body).toBe('from role');
  });
});

describe('loadSkillsForRole + injectSkillsIntoPrompt', () => {
  it('loads allowlisted skills for a role and injects into prompt', async () => {
    const root = await createTempRoot({
      'xiaozhen/skills/release-smoke/SKILL.md': `---
name: release-smoke
description: smoke checklist
---
Run typecheck then vitest.
`,
      'xiaozhen/skills/ignored/SKILL.md': `---
name: ignored
---
should not inject
`,
    });

    const skills = await loadSkillsForRole({ projectRoot: root, role: 'xiaozhen' });
    expect(skills.map((s) => s.name)).toEqual(['release-smoke']);

    const prompt = injectSkillsIntoPrompt('你是小真。', skills);
    expect(prompt).toContain('你是小真。');
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('### release-smoke — smoke checklist');
    expect(prompt).toContain('Run typecheck then vitest.');
    expect(prompt).not.toContain('should not inject');
  });

  it('returns base prompt unchanged when no skills match', async () => {
    const root = await createTempRoot({});
    const skills = await loadSkillsForRole({ projectRoot: root, role: 'xiaohei' });
    expect(skills).toEqual([]);
    expect(injectSkillsIntoPrompt('base', skills)).toBe('base');
  });

  it('skips missing allowlisted skills without throwing', async () => {
    const root = await createTempRoot({});
    const skills = await loadSkillsForRole({
      projectRoot: root,
      role: 'xiaozhen',
      allowlist: { xiaozhen: ['release-smoke'] },
    });
    expect(skills).toEqual([]);
  });
});
