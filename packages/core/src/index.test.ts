import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@personal-ai/types';
import { buildAgentContext } from './index.js';

function message(content: string): ChatMessage {
  return {
    id: `m-${content}`,
    sessionId: 's-1',
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  };
}

describe('buildAgentContext', () => {
  it('assembles context with recent messages capped at 20', () => {
    const messages = Array.from({ length: 25 }, (_, i) => message(`msg-${i}`));
    const session = {
      id: 's-1',
      systemPrompt: 'persona',
      messages,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const context = buildAgentContext({
      session,
      device: { deviceId: 'car-1', deviceType: 'car', audioOnly: true },
      availableTools: ['weather.get'],
    });
    expect(context.recentMessages).toHaveLength(20);
    expect(context.recentMessages[0]?.content).toBe('msg-5');
    expect(context.location).toBeUndefined();
    expect(context.availableTools).toEqual(['weather.get']);
    expect(context.persona).toBe('persona');
  });
});
