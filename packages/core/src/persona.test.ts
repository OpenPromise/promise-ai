import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePersonaProvider } from './persona.js';

const tempDirs: string[] = [];

async function createTempPersonaDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'persona-test-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('FilePersonaProvider', () => {
  it('composes a system prompt from persona markdown files', async () => {
    const dir = await createTempPersonaDir({
      'identity.md': '# Identity\n- 成熟女性私人 AI 助理',
      'personality.md': '- 自信、从容',
      'speaking-style.md': '- 简洁自然',
      'behavior-rules.md': '- 不越权',
    });

    const provider = new FilePersonaProvider({
      personaDir: dir,
      voiceProfile: { voiceId: 'voice-001', model: 'eleven_multilingual_v2' },
    });

    const prompt = await provider.getSystemPrompt();
    expect(prompt).toContain('## 身份');
    expect(prompt).toContain('成熟女性私人 AI 助理');
    expect(prompt).toContain('## 人格');
    expect(prompt).toContain('## 说话风格');
    expect(prompt).toContain('## 行为准则');

    const voice = await provider.getVoiceProfile();
    expect(voice.voiceId).toBe('voice-001');
    expect(voice.model).toBe('eleven_multilingual_v2');
  });

  it('skips missing files', async () => {
    const dir = await createTempPersonaDir({
      'identity.md': '# Identity\n- 测试人格',
    });

    const provider = new FilePersonaProvider({ personaDir: dir });
    const prompt = await provider.getSystemPrompt();
    expect(prompt).toContain('测试人格');
    expect(prompt).not.toContain('## 人格');
  });

  it('falls back to a default voice profile', async () => {
    const dir = await createTempPersonaDir({ 'identity.md': 'x' });
    const provider = new FilePersonaProvider({ personaDir: dir });
    await expect(provider.getVoiceProfile()).resolves.toEqual({ voiceId: 'default' });
  });

  it('throws when no persona files exist', async () => {
    const dir = await createTempPersonaDir({});
    const provider = new FilePersonaProvider({ personaDir: dir });
    await expect(provider.getSystemPrompt()).rejects.toThrow(/No persona files found/);
  });

  it('re-reads files on every call', async () => {
    const dir = await createTempPersonaDir({ 'identity.md': 'v1' });
    const provider = new FilePersonaProvider({ personaDir: dir });

    const first = await provider.getSystemPrompt();
    expect(first).toContain('v1');

    await writeFile(path.join(dir, 'identity.md'), 'v2', 'utf8');
    const second = await provider.getSystemPrompt();
    expect(second).toContain('v2');
    expect(second).not.toContain('v1');
  });

  it('小夜行为准则写明同事都有收件箱、不能互相派单', async () => {
    const rulesPath = path.resolve(import.meta.dirname, '../../../persona/behavior-rules.md');
    const rules = await readFile(rulesPath, 'utf8');
    expect(rules).toContain('五位同事都有自己的收件箱');
    expect(rules).toContain('同事不能互相派单');
    expect(rules).toContain('不要说「没有信箱」');
  });
});
