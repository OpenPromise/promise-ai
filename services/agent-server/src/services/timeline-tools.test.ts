import { describe, expect, it } from 'vitest';
import { InMemoryTimelineStore } from '@personal-ai/memory';
import { createTimelineTools } from './timeline-tools.js';

function makeTools() {
  const store = new InMemoryTimelineStore();
  const tools = createTimelineTools({ store });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { store, byName };
}

describe('timeline.* 工具', () => {
  it('权限：list=L0，add=L1', () => {
    const { byName } = makeTools();
    expect(byName.get('timeline.list')?.permissionLevel).toBe(0);
    expect(byName.get('timeline.add')?.permissionLevel).toBe(1);
  });

  it('add 记录事件，list 返回', async () => {
    const { byName } = makeTools();
    const added = await byName.get('timeline.add')!.execute(
      { summary: '下个月 15 号搬家', type: 'note' },
      { sessionId: 's1' },
    );
    expect(added.ok).toBe(true);
    const listed = await byName.get('timeline.list')!.execute({}, { sessionId: 's1' });
    const data = listed.data as { count: number; events: Array<{ summary: string }> };
    expect(data.count).toBe(1);
    expect(data.events[0]?.summary).toBe('下个月 15 号搬家');
  });

  it('缺少 summary 校验失败', async () => {
    const { byName } = makeTools();
    const result = await byName.get('timeline.add')!.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
  });
});
