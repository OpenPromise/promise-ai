import { describe, expect, it } from 'vitest';
import { InMemoryWorldStore } from '@personal-ai/memory';
import { createWorldTools } from './world-tools.js';
import { WorldService } from './world-service.js';

function makeTools() {
  const store = new InMemoryWorldStore();
  const service = new WorldService({ store });
  const tools = createWorldTools({ store, service });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { store, service, byName };
}

describe('world.* 工具', () => {
  it('权限：state=L0，act=L1', () => {
    const { byName } = makeTools();
    expect(byName.get('world.state')?.permissionLevel).toBe(0);
    expect(byName.get('world.act')?.permissionLevel).toBe(1);
  });

  it('world.state 返回当前世界状态', async () => {
    const { byName } = makeTools();
    const result = await byName.get('world.state')!.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect((result.data as { location: string }).location).toBe('客厅');
  });

  it('world.act 让她做一件事并写入状态', async () => {
    const { byName } = makeTools();
    const result = await byName.get('world.act')!.execute(
      { label: '去阳台看晚霞', location: '阳台', durationMin: 45 },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    const data = result.data as { applied: boolean; state: { activity: { label: string } } };
    expect(data.applied).toBe(true);
    expect(data.state.activity.label).toBe('去阳台看晚霞');
  });

  it('world.act 缺 label 拒绝', async () => {
    const { byName } = makeTools();
    const result = await byName.get('world.act')!.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
  });
});
