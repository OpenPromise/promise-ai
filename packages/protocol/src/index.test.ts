import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, createEnvelope } from './index.js';

describe('protocol', () => {
  it('exposes a protocol version', () => {
    expect(PROTOCOL_VERSION).toBe('1.0');
  });

  it('creates a complete envelope with default requestId', () => {
    const envelope = createEnvelope({
      type: 'chat.token',
      sessionId: 's-1',
      payload: { delta: 'hi' },
    });
    expect(envelope.type).toBe('chat.token');
    expect(envelope.sessionId).toBe('s-1');
    expect(envelope.requestId.length).toBeGreaterThan(0);
    expect(new Date(envelope.timestamp).getTime()).not.toBeNaN();
    expect(envelope.payload).toEqual({ delta: 'hi' });
    expect('deviceId' in envelope).toBe(false);
  });

  it('keeps deviceId when provided', () => {
    const envelope = createEnvelope({
      type: 'chat.token',
      sessionId: 's-1',
      deviceId: 'desktop-001',
      payload: null,
    });
    expect(envelope.deviceId).toBe('desktop-001');
  });
});
