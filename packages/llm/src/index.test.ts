import { describe, expect, it } from 'vitest';
import { finalizeToolCalls, parseSseLine } from './index.js';

describe('parseSseLine', () => {
  it('extracts data payloads', () => {
    expect(parseSseLine('data: hello')).toBe('hello');
    expect(parseSseLine('data: [DONE]')).toBe('[DONE]');
  });

  it('ignores non-data lines', () => {
    expect(parseSseLine('event: message')).toBeNull();
    expect(parseSseLine(': keepalive')).toBeNull();
    expect(parseSseLine('')).toBeNull();
  });
});

describe('finalizeToolCalls', () => {
  it('fills missing ids with a per-index fallback', () => {
    const calls = finalizeToolCalls([
      { index: 0, id: 'call_1', name: 'weather.get', arguments: '{}' },
      { index: 1, id: undefined, name: 'time.get', arguments: '{"tz":"Asia/Shanghai"}' },
    ]);
    expect(calls).toEqual([
      { id: 'call_1', name: 'weather.get', arguments: '{}' },
      { id: 'call_1', name: 'time.get', arguments: '{"tz":"Asia/Shanghai"}' },
    ]);
  });

  it('skips calls without a name', () => {
    const calls = finalizeToolCalls([
      { index: 0, id: 'call_1', name: undefined, arguments: '{}' },
      { index: 1, id: 'call_2', name: 'weather.get', arguments: '{}' },
    ]);
    expect(calls).toEqual([{ id: 'call_2', name: 'weather.get', arguments: '{}' }]);
  });
});
