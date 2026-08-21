import { describe, expect, it } from 'vitest';
import { ToolRegistry, type DesktopToolDeclaration } from '@personal-ai/tools';
import { DESKTOP_FORCED_PERMISSION_LEVEL, DesktopToolBridge } from './desktop-bridge.js';

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
    // 注册名带 desktop. 命名空间前缀，远端执行仍用桌面端原始工具名
    expect(registered).toEqual(['desktop.terminal.run']);
    expect(registry.has('desktop.terminal.run')).toBe(true);
    expect(registry.has('terminal.run')).toBe(false);

    const promise = registry
      .get('desktop.terminal.run')!
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
      .get('desktop.terminal.run')!
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
    const result = await registry.get('desktop.slow.tool')!.execute({}, { sessionId: 's1' });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('超时');
  });

  it('unregisters tools and rejects pending calls when the desktop disconnects', async () => {
    const registry = new ToolRegistry();
    const fake = new FakeWebSocket();
    const bridge = new DesktopToolBridge(registry, fake as never, { timeoutMs: 5000 });
    bridge.registerTools([declaration]);

    const promise = registry
      .get('desktop.terminal.run')!
      .execute({ command: 'x' }, { sessionId: 's1' });
    fake.emit('close');

    expect(registry.has('desktop.terminal.run')).toBe(false);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('桌面端已断开');
  });

  it('handles hello by registering declared tools', async () => {
    const registry = new ToolRegistry();
    const fake = new FakeWebSocket();
    const bridge = new DesktopToolBridge(registry, fake as never);

    fake.emit('message', Buffer.from(JSON.stringify({ type: 'hello', tools: [declaration] })));
    expect(registry.has('desktop.terminal.run')).toBe(true);
    expect(fake.lastSentJson()).toEqual({
      type: 'tools.registered',
      tools: ['desktop.terminal.run'],
    });
    void bridge;
  });

  it('服务端强制 L2：忽略客户端自报的 permissionLevel', () => {
    const registry = new ToolRegistry();
    const fake = new FakeWebSocket();
    const bridge = new DesktopToolBridge(registry, fake as never);

    // declaration 自报 L3，另一个自报 L0——都必须被强制成 L2
    bridge.registerTools([
      declaration,
      {
        name: 'filesystem.read',
        description: 'read',
        inputSchema: { type: 'object', properties: {} },
        permissionLevel: 0,
      },
    ]);
    expect(registry.get('desktop.terminal.run')?.permissionLevel).toBe(
      DESKTOP_FORCED_PERMISSION_LEVEL,
    );
    expect(registry.get('desktop.filesystem.read')?.permissionLevel).toBe(2);
  });

  it('#cleanup 只注销仍归属自己的工具：A 断开不影响 B 重新注册的同名工具', async () => {
    const registry = new ToolRegistry();
    const fakeA = new FakeWebSocket();
    const fakeB = new FakeWebSocket();
    const bridgeA = new DesktopToolBridge(registry, fakeA as never, { timeoutMs: 5000 });
    bridgeA.registerTools([declaration]);
    const toolFromA = registry.get('desktop.terminal.run');

    // A 断开 → 注销自己的注册；B 连上来重新注册同名工具
    fakeA.emit('close');
    const bridgeB = new DesktopToolBridge(registry, fakeB as never, { timeoutMs: 5000 });
    bridgeB.registerTools([declaration]);
    const toolFromB = registry.get('desktop.terminal.run');
    expect(toolFromB).toBeDefined();
    expect(toolFromB).not.toBe(toolFromA);

    // A 再次触发 cleanup（error 事件），不能删掉 B 的工具
    fakeA.emit('error', new Error('boom'));
    expect(registry.get('desktop.terminal.run')).toBe(toolFromB);
  });

  it('context.signal abort 时立即结束并向桌面端发 tool.cancel', async () => {
    const registry = new ToolRegistry();
    const fake = new FakeWebSocket();
    const bridge = new DesktopToolBridge(registry, fake as never, { timeoutMs: 60_000 });
    bridge.registerTools([declaration]);

    const controller = new AbortController();
    const promise = registry
      .get('desktop.terminal.run')!
      .execute({ command: 'sleep 999' }, { sessionId: 's1', signal: controller.signal });
    const executeMessage = fake.lastSentJson();
    expect(executeMessage.type).toBe('tool.execute');

    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('已取消');
    const cancelMessage = fake.lastSentJson();
    expect(cancelMessage.type).toBe('tool.cancel');
    expect(cancelMessage.requestId).toBe(executeMessage.requestId);
    expect(cancelMessage.name).toBe('terminal.run');

    // 取消后迟到的 tool.result 不应再改变结果（pending 已清理）
    fake.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'tool.result', requestId: executeMessage.requestId, ok: true })),
    );
  });

  it('已 abort 的 signal 直接返回取消，不下发执行', async () => {
    const registry = new ToolRegistry();
    const fake = new FakeWebSocket();
    const bridge = new DesktopToolBridge(registry, fake as never, { timeoutMs: 60_000 });
    bridge.registerTools([declaration]);

    const controller = new AbortController();
    controller.abort();
    const result = await registry
      .get('desktop.terminal.run')!
      .execute({}, { sessionId: 's1', signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('已取消');
    expect(fake.sent.some((raw) => raw.includes('"tool.execute"'))).toBe(false);
  });
});
