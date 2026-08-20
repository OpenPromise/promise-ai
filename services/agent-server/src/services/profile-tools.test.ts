import { describe, expect, it } from 'vitest';
import { InMemoryProfileStore } from '@personal-ai/memory';
import { createProfileTools } from './profile-tools.js';

function makeTools() {
  const store = new InMemoryProfileStore();
  const tools = createProfileTools({ store });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { store, byName };
}

describe('profile.* 用户画像工具', () => {
  it('权限分级：list=L0，set/forget=L1', () => {
    const { byName } = makeTools();
    expect(byName.get('profile.list')?.permissionLevel).toBe(0);
    expect(byName.get('profile.set')?.permissionLevel).toBe(1);
    expect(byName.get('profile.forget')?.permissionLevel).toBe(1);
  });

  it('set 记录并覆盖，list 返回全部', async () => {
    const { byName } = makeTools();
    await byName.get('profile.set')!.execute(
      { key: 'name', value: '小夜', category: 'fact' },
      { sessionId: 's1' },
    );
    await byName.get('profile.set')!.execute(
      { key: '作息', value: '夜猫子', category: 'habit' },
      { sessionId: 's1' },
    );
    await byName.get('profile.set')!.execute(
      { key: 'name', value: '夜夜' },
      { sessionId: 's1' },
    );
    const result = await byName.get('profile.list')!.execute({}, { sessionId: 's1' });
    const data = result.data as { count: number; entries: Array<{ key: string }> };
    expect(data.count).toBe(2);
    expect(data.entries.map((e) => e.key).sort()).toEqual(['name', '作息']);
  });

  it('forget 删除指定条目', async () => {
    const { byName } = makeTools();
    await byName.get('profile.set')!.execute({ key: 'a', value: '1' }, { sessionId: 's1' });
    await byName.get('profile.set')!.execute({ key: 'b', value: '2' }, { sessionId: 's1' });
    const result = await byName.get('profile.forget')!.execute({ key: 'a' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect((result.data as { remaining: number }).remaining).toBe(1);
  });

  it('缺少参数/超长校验失败', async () => {
    const { byName } = makeTools();
    const noValue = await byName.get('profile.set')!.execute({ key: 'x' }, { sessionId: 's1' });
    expect(noValue.ok).toBe(false);
    const tooLong = await byName.get('profile.set')!.execute(
      { key: 'k', value: 'x'.repeat(501) },
      { sessionId: 's1' },
    );
    expect(tooLong.ok).toBe(false);
  });
});
