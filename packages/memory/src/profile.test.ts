import { describe, expect, it } from 'vitest';
import { InMemoryProfileStore, resolveRollbackTarget } from './profile.js';

describe('InMemoryProfileStore 变更历史与回滚', () => {
  it('upsert 记录 ADD/UPDATE，remove 记录 DELETE', async () => {
    const store = new InMemoryProfileStore();
    await store.upsertEntry('default', { key: 'name', value: '夜夜', category: 'fact' });
    await store.upsertEntry('default', { key: 'name', value: '小明', category: 'fact' });
    await store.removeEntry('default', 'name');
    const history = await store.listHistory('default', { key: 'name' });
    expect(history.map((e) => e.event)).toEqual(['DELETE', 'UPDATE', 'ADD']);
    expect(history[1]?.oldValue).toBe('夜夜');
    expect(history[1]?.newValue).toBe('小明');
  });

  it('相同值重复 upsert 不产生冗余事件', async () => {
    const store = new InMemoryProfileStore();
    await store.upsertEntry('default', { key: 'a', value: '1', category: 'fact' });
    await store.upsertEntry('default', { key: 'a', value: '1', category: 'fact' });
    const history = await store.listHistory('default', { key: 'a' });
    expect(history).toHaveLength(1);
  });

  it('rollback 撤销最近一次修改并记录新事件', async () => {
    const store = new InMemoryProfileStore();
    await store.upsertEntry('default', { key: 'name', value: '夜夜', category: 'fact' });
    await store.upsertEntry('default', { key: 'name', value: '小明', category: 'fact' });
    await store.rollbackEntry('default', 'name');
    const profile = await store.getProfile('default');
    expect(profile?.entries.find((e) => e.key === 'name')?.value).toBe('夜夜');
    const history = await store.listHistory('default', { key: 'name' });
    // 撤销产生一条新事件（UPDATE，旧=小明，新=夜夜）
    expect(history[0]?.event).toBe('UPDATE');
    expect(history[0]?.oldValue).toBe('小明');
    expect(history[0]?.newValue).toBe('夜夜');
  });

  it('rollback 到指定事件恢复该点状态', async () => {
    const store = new InMemoryProfileStore();
    await store.upsertEntry('default', { key: 'name', value: '夜夜', category: 'fact' });
    await store.upsertEntry('default', { key: 'name', value: '小明', category: 'fact' });
    const history = await store.listHistory('default', { key: 'name' });
    const addEvent = history[1]!; // ADD 事件
    await store.rollbackEntry('default', 'name', { toEventId: addEvent.id });
    expect((await store.getProfile('default'))?.entries.find((e) => e.key === 'name')?.value).toBe(
      '夜夜',
    );
  });

  it('撤销 ADD（唯一事件）后删除该条目', async () => {
    const store = new InMemoryProfileStore();
    await store.upsertEntry('default', { key: 'name', value: '夜夜', category: 'fact' });
    await store.rollbackEntry('default', 'name');
    expect((await store.getProfile('default'))?.entries.find((e) => e.key === 'name')).toBeUndefined();
  });
});

describe('resolveRollbackTarget', () => {
  it('无历史返回 null', () => {
    expect(resolveRollbackTarget([], undefined)).toBeNull();
  });
});
