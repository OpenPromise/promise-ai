import type { ChatMessage, DeviceInfo, Session } from '@personal-ai/types';

export { FilePersonaProvider } from './persona.js';
export type { FilePersonaProviderOptions, PersonaFileSpec } from './persona.js';
export { PERSONA_FILES } from './persona.js';

export interface VoiceProfile {
  voiceId: string;
  model?: string;
  settings?: Record<string, unknown>;
}

export interface PersonaProvider {
  getSystemPrompt(): Promise<string>;
  getVoiceProfile(): Promise<VoiceProfile>;
}

export interface AgentUser {
  userId: string;
  name?: string;
}

export interface AgentContext {
  user?: AgentUser;
  device?: DeviceInfo;
  location?: string;
  currentSession: Session;
  recentMessages: ChatMessage[];
  relevantMemories: unknown[];
  availableTools: string[];
  activeTasks: string[];
  permissions: string[];
  persona: string;
}

export interface BuildAgentContextInput {
  session: Session;
  user?: AgentUser;
  device?: DeviceInfo;
  persona?: string;
  availableTools?: string[];
}

export function buildAgentContext(input: BuildAgentContextInput): AgentContext {
  return {
    user: input.user,
    device: input.device,
    location: input.device?.location,
    currentSession: input.session,
    recentMessages: input.session.messages.slice(-20),
    relevantMemories: [],
    availableTools: input.availableTools ?? [],
    activeTasks: [],
    permissions: [],
    persona: input.persona ?? input.session.systemPrompt,
  };
}
