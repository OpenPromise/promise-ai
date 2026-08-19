import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PersonaProvider, VoiceProfile } from './index.js';

export interface PersonaFileSpec {
  name: string;
  title: string;
}

export const PERSONA_FILES: PersonaFileSpec[] = [
  { name: 'identity.md', title: '身份' },
  { name: 'personality.md', title: '人格' },
  { name: 'speaking-style.md', title: '说话风格' },
  { name: 'behavior-rules.md', title: '行为准则' },
  { name: 'self-development.md', title: '自我开发规则' },
  { name: 'refinements.md', title: '经验与改进' },
];

export interface FilePersonaProviderOptions {
  personaDir: string;
  voiceProfile?: VoiceProfile;
}

/**
 * Loads a persona from a directory of Markdown files
 * (identity / personality / speaking-style / behavior-rules) and composes
 * them into a single System Prompt. Files are re-read on every call, so
 * persona edits take effect without a server restart.
 */
export class FilePersonaProvider implements PersonaProvider {
  readonly #personaDir: string;
  readonly #voiceProfile: VoiceProfile;

  constructor(options: FilePersonaProviderOptions) {
    this.#personaDir = options.personaDir;
    this.#voiceProfile = options.voiceProfile ?? { voiceId: 'default' };
  }

  async getSystemPrompt(): Promise<string> {
    const sections: string[] = [];

    for (const file of PERSONA_FILES) {
      try {
        const content = await readFile(path.join(this.#personaDir, file.name), 'utf8');
        const trimmed = content.trim();
        if (trimmed.length > 0) {
          sections.push(`## ${file.title}\n${trimmed}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        // missing persona files are skipped
      }
    }

    if (sections.length === 0) {
      throw new Error(`No persona files found in ${this.#personaDir}`);
    }

    return `你是一个私人 AI 助理。以下是你的人设，必须严格遵守：\n\n${sections.join('\n\n')}`;
  }

  async getVoiceProfile(): Promise<VoiceProfile> {
    return this.#voiceProfile;
  }
}
