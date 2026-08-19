import { describe, expect, it } from 'vitest';
import { ToolRegistry, type DesktopToolDeclaration } from '@personal-ai/tools';
import { DesktopToolBridge } from './desktop-bridge.js';

class FakeWebSocket {
  readyState = 1;
  sent: string[] = [];
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, cb: (...args: unknown[]) => void): this {
    const list = this.#listeners.get(event) ?? [];
    list.push(cb);
    this.#listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.#listeners.get(event) ?? []) cb(...args);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  lastSentJson(): Record<string, unknown> {
    return JSON.parse(this.sent.at(-1) ?? '{}') as Record<string, unknown>;
  }
}

const declaration: DesktopToolDeclaration = {
  name: 'terminal.run',
  description: 'run a command',
  inputSchema: { type: 'object', properties: {} },
  permissionLevel: 3,
};

describe('DesktopToolBridge', () => {
  it('registers declared tools and forwards execution over the websocket', async () => {
    const registry = new ToolRegistry();
    const fake = new FakeWebSocket();
    const bridge = new DesktopToolBridge(registry, fake as never, { timeoutMs: 5000 });

    const registered = bridge.registerTools([declaration]);
    expect(registered).toEqual(['terminal.run']);
    expect(registry.has('terminal.run')).toBe(true);

    const promise = registry
      .get('terminal.run')!
      .execute({ command: 'Get-Date' }, { sessionId: 's1' });
    const sent = fake.lastSentJson();
    expect(sent.type).toBe('tool.execute');
    expect(sent.name).toBe('terminal.run');
    expect(sent.sessionId).toBe('s1');

    fake.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'tool.result',
          requestId: sent.requestId,
          ok: true,
          data: { stdout: '2026-08-19' },
        }),
      ),
    );
    const result = await promise;
    expect(result).toEqual({ ok: true, data: { stdout: '2026-08-19' } });
    void bridge;
  });

  it('times out when the desktop does not answer', async () => {
    const registry = new ToolRegistry();
    const fake = new FakeWebSocket();
    const bridge = new DesktopToolBridge(registry, fake as never, { timeoutMs: 30 });

    bridge.registerTools([declaration]);
    const result = await registry
      .get('terminal.run')!
      .execute({ command: 'x' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('超时');
  });

  it('honors a per-tool timeoutMs override', async () => {
    const registry = new ToolRegistry();
    const fake = new FakeWebSocket();
    const bridge = new DesktopToolBridge(registry, fake as never, { timeoutMs: 5000 });

    bridge.registerTools([
      {
        name: 'slow.tool',
        description: 'slow',
        inputSchema: { type: 'object', properties: {} },
        permissionLevel: 1,
        timeoutMs: 50,
      },
    ]);
    const startedAt = Date.now();
    const result = await registry.get('slow.tool')!.execute({}, { sessionId: 's1' });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('超时');
  });

  it('unregisters tools and rejects pending calls when the desktop disconnects', async () => {
    const registry = new ToolRegistry();
    const fake = new FakeWebSocket();
    const bridge = new DesktopToolBridge(registry, fake as never, { timeoutMs: 5000 });
    bridge.registerTools([declaration]);

    const promise = registry.get('terminal.run')!.execute({ command: 'x' }, { sessionId: 's1' });
    fake.emit('close');

    expect(registry.has('terminal.run')).toBe(false);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('桌面端已断开');
  });

  it('handles hello by registering declared tools', async () => {
    const registry = new ToolRegistry();
    const fake = new FakeWebSocket();
    const bridge = new DesktopToolBridge(registry, fake as never);

    fake.emit('message', Buffer.from(JSON.stringify({ type: 'hello', tools: [declaration] })));
    expect(registry.has('terminal.run')).toBe(true);
    expect(fake.lastSentJson()).toEqual({
      type: 'tools.registered',
      tools: ['terminal.run'],
    });
    void bridge;
  });
});
