import { describe, expect, it } from 'vitest';
import { createSelfTools } from './self-tools.js';

describe('createSelfTools', () => {
  it('registers self.info / self.check / system.restart with safe permission levels', () => {
    const tools = createSelfTools({ projectRoot: process.cwd(), memoryBackend: 'postgres' });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.has('self.info')).toBe(true);
    expect(byName.has('self.check')).toBe(true);
    expect(byName.has('system.restart')).toBe(true);

    expect(byName.get('self.info')?.permissionLevel).toBe(0);
    expect(byName.get('self.check')?.permissionLevel).toBe(1);
    // 重启是高风险操作：L3（二次确认）。
    expect(byName.get('system.restart')?.permissionLevel).toBe(3);
  });

  it('self.info reports the project root and version', async () => {
    const tools = createSelfTools({ projectRoot: process.cwd(), memoryBackend: 'postgres' });
    const info = tools.find((tool) => tool.name === 'self.info');
    expect(info).toBeDefined();
    const result = await info!.execute({}, { sessionId: 'test' });
    expect(result.ok).toBe(true);
    const data = result.data as { root: string; version: string; memoryBackend: string };
    expect(data.root).toBe(process.cwd());
    expect(data.version).toBeTruthy();
    expect(data.memoryBackend).toBe('postgres');
  });
});
