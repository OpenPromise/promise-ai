import { describe, expect, it } from 'vitest';
import { InMemoryMemoryStore } from '@personal-ai/memory';
import { createGoalTools, GOAL_PREFIX, parseGoal } from './goal-tools.js';

interface GoalListData {
  count: number;
  goals: Array<{ id: string; title: string; description: string }>;
}

describe('parseGoal', () => {
  it('parses title and optional description', () => {
    expect(parseGoal(`${GOAL_PREFIX}减肥：三个月减 5 公斤`)).toEqual({
      title: '减肥',
      description: '三个月减 5 公斤',
    });
    expect(parseGoal(`${GOAL_PREFIX}早起`)).toEqual({ title: '早起', description: '' });
    expect(parseGoal('普通记忆')).toBeNull();
  });
});

describe('createGoalTools', () => {
  it('sets, lists, replaces and removes goals', async () => {
    const store = new InMemoryMemoryStore();
    const tools = createGoalTools(store);
    const set = tools.find((tool) => tool.name === 'goal.set')!;
    const list = tools.find((tool) => tool.name === 'goal.list')!;
    const done = tools.find((tool) => tool.name === 'goal.done')!;

    await set.execute({ title: '减肥', description: '三个月减 5 公斤' }, { sessionId: 's1' });
    await set.execute({ title: '学日语' }, { sessionId: 's1' });

    let listed = (await list.execute({}, { sessionId: 's1' })).data as GoalListData;
    expect(listed.count).toBe(2);

    // 相同 title 覆盖，不产生重复
    await set.execute({ title: '减肥', description: '半年减 3 公斤' }, { sessionId: 's1' });
    listed = (await list.execute({}, { sessionId: 's1' })).data as GoalListData;
    expect(listed.count).toBe(2);
    expect(listed.goals.find((goal) => goal.title === '减肥')?.description).toBe('半年减 3 公斤');

    const doneByTitle = await done.execute({ title: '学日语' }, { sessionId: 's1' });
    expect(doneByTitle.ok).toBe(true);
    listed = (await list.execute({}, { sessionId: 's1' })).data as GoalListData;
    expect(listed.count).toBe(1);

    const missing = await done.execute({ title: '不存在的目标' }, { sessionId: 's1' });
    expect(missing.ok).toBe(false);
    const noArgs = await done.execute({}, { sessionId: 's1' });
    expect(noArgs.ok).toBe(false);
  });
});
