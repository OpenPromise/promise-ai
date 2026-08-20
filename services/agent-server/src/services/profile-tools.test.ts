import { describe, expect, it } from 'vitest';
import { InMemoryAvatarStore, InMemoryProfileStore } from '@personal-ai/memory';
import type { GenerateResult, LLMProvider } from '@personal-ai/llm';
import { createProfileTools } from './profile-tools.js';

function makeTools() {
  const store = new InMemoryProfileStore();
  const llm: LLMProvider = {
    name: 'fake',
    model: 'test',
    configured: true,
    async *chat() {
      yield { delta: '' };
    },
    async generate(): Promise<GenerateResult> {
      return {
        text: '{"facts":[{"key":"name","value":"夜夜","category":"fact"}]}',
      };
    },
  };
  const tools = createProfileTools({ store, llm });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { store, byName, llm };
}

describe('profile.* 用户画像工具', () => {
  it('权限分级：list=L0，set/forget=L1', () => {
    const { byName } = makeTools();
    expect(byName.get('profile.list')?.permissionLevel).toBe(0);
    expect(byName.get('profile.set')?.permissionLevel).toBe(1);
    expect(byName.get('profile.forget')?.permissionLevel).toBe(1);
    expect(byName.get('profile.compact')?.permissionLevel).toBe(1);
    expect(byName.get('profile.history')?.permissionLevel).toBe(0);
    expect(byName.get('profile.rollback')?.permissionLevel).toBe(1);
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

  it('compact 在条数超过 20 时整理画像', async () => {
    const { store, byName } = makeTools();
    for (let i = 0; i < 25; i++) {
      await store.upsertEntry('default', {
        key: `条目${i}`,
        value: `值${i}`,
        category: 'fact',
      });
    }
    const result = await byName.get('profile.compact')!.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    const data = result.data as { compacted: boolean; before: number; after: number };
    expect(data.compacted).toBe(true);
    expect(data.before).toBe(25);
    expect(data.after).toBe(1);
    const profile = await store.getProfile('default');
    expect(profile?.entries).toHaveLength(1);
  });

  it('history 返回变更历史（新→旧）', async () => {
    const { byName } = makeTools();
    await byName.get('profile.set')!.execute({ key: 'name', value: '夜夜' }, { sessionId: 's1' });
    await byName.get('profile.set')!.execute({ key: 'name', value: '小明' }, { sessionId: 's1' });
    const result = await byName.get('profile.history')!.execute(
      { key: 'name' },
      { sessionId: 's1' },
    );
    const data = result.data as {
      events: Array<{ event: string; oldValue?: string; newValue?: string }>;
    };
    expect(data.events[0]?.event).toBe('UPDATE');
    expect(data.events[0]?.oldValue).toBe('夜夜');
    expect(data.events[0]?.newValue).toBe('小明');
    expect(data.events[1]?.event).toBe('ADD');
  });

  it('rollback 撤销最近一次修改', async () => {
    const { byName } = makeTools();
    await byName.get('profile.set')!.execute({ key: 'name', value: '夜夜' }, { sessionId: 's1' });
    await byName.get('profile.set')!.execute({ key: 'name', value: '小明' }, { sessionId: 's1' });
    const result = await byName.get('profile.rollback')!.execute(
      { key: 'name' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    expect((result.data as { currentValue: string }).currentValue).toBe('夜夜');
  });

  it('set 记录 preference 时同步喂 avatar 证据（user 源）', async () => {
    const { store, byName } = makeTools();
    const avatarStore = new InMemoryAvatarStore();
    const llm: LLMProvider = {
      name: 'fake',
      model: 'test',
      configured: true,
      async *chat() {
        yield { delta: '' };
      },
      async generate(): Promise<GenerateResult> {
        return { text: '' };
      },
    };
    const tools = createProfileTools({ store, llm, avatarStore });
    const setTool = tools.find((t) => t.name === 'profile.set')!;
    await setTool.execute(
      { key: '喜好', value: '喜欢蓝色', category: 'preference' },
      { sessionId: 's1' },
    );
    const prefs = await avatarStore.listPreferences();
    expect(
      prefs.some((p) => p.source === 'user' && p.parameter === 'hairColor' && p.direction === 1),
    ).toBe(true);
    expect(byName.get('profile.set')?.permissionLevel).toBe(1);
  });
});
