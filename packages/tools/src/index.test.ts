import { describe, expect, it } from 'vitest';
import type { Tool } from './index.js';
import { ToolRegistry } from './index.js';

const weatherTool: Tool = {
  name: 'weather.get',
  description: 'Get current weather',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
  permissionLevel: 0,
  execute: async (input) => ({ ok: true, data: input }),
};

const reminderTool: Tool = {
  name: 'reminder.create',
  description: 'Create a reminder',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  permissionLevel: 1,
  execute: async () => ({ ok: true, data: { created: true } }),
};

describe('ToolRegistry', () => {
  it('registers, lists and retrieves tools in order', () => {
    const registry = new ToolRegistry();
    registry.register(weatherTool);
    registry.register(reminderTool);

    expect(registry.has('weather.get')).toBe(true);
    expect(registry.get('reminder.create')?.permissionLevel).toBe(1);
    expect(registry.list().map((tool) => tool.name)).toEqual(['weather.get', 'reminder.create']);
  });

  it('rejects duplicate registrations', () => {
    const registry = new ToolRegistry();
    registry.register(weatherTool);
    expect(() => registry.register(weatherTool)).toThrow(/already registered/);
  });

  it('rejects wire-name collisions（. 与 _ 映射同名）', () => {
    const registry = new ToolRegistry();
    registry.register(weatherTool); // weather.get → weather_get
    const collision: Tool = {
      name: 'weather_get',
      description: 'collides',
      inputSchema: { type: 'object', properties: {} },
      permissionLevel: 0,
      execute: async () => ({ ok: true, data: {} }),
    };
    expect(() => registry.register(collision)).toThrow(/collision/);
  });
});
