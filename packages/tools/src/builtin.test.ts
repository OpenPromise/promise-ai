import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBuiltinTools,
  createCalendarTools,
  createFilesystemDeleteTool,
  createFilesystemSearchTool,
  createMemoryTools,
  createNotificationSendTool,
  createTaskTools,
  createReminderTools,
  InMemoryNotificationStore,
  InMemoryCalendarStore,
  InMemoryReminderStore,
} from './index.js';
import { InMemoryMemoryStore, InMemoryTaskStore } from '@personal-ai/memory';
import type { TaskToolDeps } from './task-tools.js';

describe('time.get', () => {
  it('returns the current date and time with a timezone', async () => {
    const { tools } = createBuiltinTools();
    const tool = tools.find((t) => t.name === 'time.get');
    expect(tool).toBeDefined();
    const result = await tool?.execute({ timezone: 'Asia/Shanghai' }, { sessionId: 's1' });
    expect(result?.ok).toBe(true);
    const data = result?.data as { iso: string; text: string; timezone: string };
    expect(data.iso).toBeDefined();
    expect(data.timezone).toBe('Asia/Shanghai');
    expect(data.text).toContain('2026年');
  });

  it('rejects invalid timezones', async () => {
    const { tools } = createBuiltinTools();
    const tool = tools.find((t) => t.name === 'time.get');
    const result = await tool?.execute({ timezone: 'Mars/Olympus' }, { sessionId: 's1' });
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('无效的时区');
  });
});

describe('weather.get', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves a city and returns current conditions', async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      const target = String(url);
      if (target.includes('geocoding-api')) {
        return new Response(
          JSON.stringify({
            results: [{ latitude: 39.9, longitude: 116.4, name: '北京', country: '中国' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          current: {
            temperature_2m: 28.5,
            relative_humidity_2m: 60,
            weather_code: 1,
            wind_speed_10m: 12.3,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const { tools } = createBuiltinTools({ fetchImpl: fetchMock as unknown as typeof fetch });
    const tool = tools.find((t) => t.name === 'weather.get');
    const result = await tool?.execute({ city: '北京' }, { sessionId: 's1' });
    expect(result?.ok).toBe(true);
    expect(result?.data).toMatchObject({
      city: '北京',
      condition: '大致晴朗',
      temperatureCelsius: 28.5,
      humidityPercent: 60,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports unknown cities', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { tools } = createBuiltinTools({ fetchImpl: fetchMock as unknown as typeof fetch });
    const tool = tools.find((t) => t.name === 'weather.get');
    const result = await tool?.execute({ city: '不存在城' }, { sessionId: 's1' });
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('找不到城市');
  });

  it('requires a city', async () => {
    const { tools } = createBuiltinTools();
    const tool = tools.find((t) => t.name === 'weather.get');
    const result = await tool?.execute({}, { sessionId: 's1' });
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('city');
  });
});

describe('web.search', () => {
  it('searches Wikipedia and strips HTML from snippets', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            query: {
              search: [
                { title: '人工智能', snippet: '<span class="searchmatch">人工智能</span>是…' },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const { tools } = createBuiltinTools({ fetchImpl: fetchMock as unknown as typeof fetch });
    const tool = tools.find((t) => t.name === 'web.search');
    const result = await tool?.execute({ query: '人工智能' }, { sessionId: 's1' });
    expect(result?.ok).toBe(true);
    const data = result?.data as { results: Array<{ title: string; snippet: string }> };
    expect(data.results[0]?.title).toBe('人工智能');
    expect(data.results[0]?.snippet).toBe('人工智能是…');
  });

  it('requires a query', async () => {
    const { tools } = createBuiltinTools();
    const tool = tools.find((t) => t.name === 'web.search');
    const result = await tool?.execute({}, { sessionId: 's1' });
    expect(result?.ok).toBe(false);
  });
});

describe('filesystem.search', () => {
  it('finds files by name under the allowed root only', async () => {
    const tool = createFilesystemSearchTool({
      allowedRoots: [process.cwd()],
    });
    const result = await tool.execute({ query: 'package.json', limit: 5 }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    const data = result.data as { files: string[]; count: number };
    expect(data.files.length).toBeGreaterThan(0);
    expect(data.files).toContain('package.json');
  });

  it('rejects roots outside the allowed workspace', async () => {
    const tool = createFilesystemSearchTool({
      allowedRoots: [process.cwd()],
    });
    const outsideRoot = path.resolve(path.dirname(process.cwd()), 'outside');
    const result = await tool.execute({ query: '*.md', root: outsideRoot }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不在允许的工作区内');
  });

  it('supports glob-style queries', async () => {
    const tool = createFilesystemSearchTool({
      allowedRoots: [process.cwd()],
    });
    const result = await tool.execute({ query: '*.md', limit: 10 }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect((result.data as { files: string[] }).files.length).toBeGreaterThan(0);
  });
});

describe('reminder + calendar stores', () => {
  it('creates and lists reminders in due order', async () => {
    const store = new InMemoryReminderStore();
    const reminderTools = createReminderTools(store);
    const createTool = reminderTools[0]!;
    const listTool = reminderTools[1]!;
    const created = await createTool.execute(
      { text: '开会', dueAt: '2026-08-20T09:00:00+08:00' },
      { sessionId: 's1' },
    );
    expect(created.ok).toBe(true);

    const listed = await listTool.execute({}, { sessionId: 's1' });
    const reminders = (listed.data as { reminders: Array<{ text: string }> }).reminders;
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.text).toBe('开会');
  });

  it('validates reminder dueAt', async () => {
    const createTool = createReminderTools()[0]!;
    const result = await createTool.execute(
      { text: '无效时间', dueAt: 'not-a-date' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(false);
  });

  it('creates and filters calendar events by range', async () => {
    const store = new InMemoryCalendarStore();
    const calendarTools = createCalendarTools(store);
    const createTool = calendarTools[0]!;
    const listTool = calendarTools[1]!;
    await createTool.execute(
      { title: '发布', startAt: '2026-08-25T10:00:00+08:00' },
      { sessionId: 's1' },
    );
    const listed = await listTool.execute(
      { from: '2026-08-01T00:00:00+08:00', to: '2026-08-31T23:59:59+08:00' },
      { sessionId: 's1' },
    );
    const events = (listed.data as { events: Array<{ title: string }> }).events;
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe('发布');

    const outside = await listTool.execute(
      { from: '2026-09-01T00:00:00+08:00', to: '2026-09-30T23:59:59+08:00' },
      { sessionId: 's1' },
    );
    expect((outside.data as { events: unknown[] }).events).toHaveLength(0);
  });
});

describe('sensitive tools', () => {
  it('notification.send stores a notification (L2)', async () => {
    const store = new InMemoryNotificationStore();
    const tool = createNotificationSendTool(store);
    const result = await tool.execute({ text: '该吃饭了' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.text).toBe('该吃饭了');
  });

  it('notification.send requires text', async () => {
    const tool = createNotificationSendTool();
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
  });

  it('filesystem.delete rejects paths outside the allowed root', async () => {
    const tool = createFilesystemDeleteTool({ allowedRoots: [process.cwd()] });
    const result = await tool.execute({ path: '..\\..\\Windows\\win.ini' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不在允许的工作区内');
  });
});

describe('memory tools', () => {
  it('remembers, lists, edits and forgets', async () => {
    const store = new InMemoryMemoryStore();
    const memoryTools = createMemoryTools(store);
    const remember = memoryTools[0]!;
    const list = memoryTools[1]!;
    const forget = memoryTools[2]!;
    const edit = memoryTools[3]!;

    const created = await remember.execute(
      { kind: 'semantic', content: '用户喜欢喝美式咖啡' },
      { sessionId: 's1' },
    );
    expect(created.ok).toBe(true);

    const listed = await list.execute({}, { sessionId: 's1' });
    const memories = (listed.data as { memories: Array<{ id: string; content: string }> }).memories;
    expect(memories).toHaveLength(1);

    const id = memories[0]!.id;
    const edited = await edit.execute({ id, content: '用户喜欢喝拿铁' }, { sessionId: 's1' });
    expect(edited.ok).toBe(true);
    expect((await store.list())[0]?.content).toBe('用户喜欢喝拿铁');

    const forgotten = await forget.execute({ id }, { sessionId: 's1' });
    expect(forgotten.ok).toBe(true);
    expect(await store.list()).toHaveLength(0);
  });

  it('validates remember input', async () => {
    const memoryTools = createMemoryTools(new InMemoryMemoryStore());
    const remember = memoryTools[0]!;
    const result = await remember.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('content');
  });
});

describe('task tools', () => {
  const deps: TaskToolDeps = {
    tasks: new InMemoryTaskStore(),
    createTaskSession: async () => 'task-session-1',
    validateSchedule: (schedule) => (schedule === 'bad' ? '无效的 cron 表达式' : null),
  };

  it('creates, lists and deletes tasks', async () => {
    const taskTools = createTaskTools(deps);
    const create = taskTools[0]!;
    const list = taskTools[1]!;
    const deleteTool = taskTools[2]!;

    const created = await create.execute(
      { name: '每日天气', schedule: '0 9 * * *', action: '检查杭州天气' },
      { sessionId: 's1' },
    );
    expect(created.ok).toBe(true);

    const listed = await list.execute({}, { sessionId: 's1' });
    const tasks = (listed.data as { tasks: Array<{ id: string; name: string }> }).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.name).toBe('每日天气');

    const deleted = await deleteTool.execute({ id: tasks[0]!.id }, { sessionId: 's1' });
    expect(deleted.ok).toBe(true);
    expect(await deps.tasks.listTasks()).toHaveLength(0);
  });

  it('rejects invalid cron schedules', async () => {
    const taskTools = createTaskTools(deps);
    const create = taskTools[0]!;
    const result = await create.execute(
      { name: '坏任务', schedule: 'bad', action: 'x' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('无效');
  });

  it('lists task runs', async () => {
    const taskTools = createTaskTools(deps);
    const create = taskTools[0]!;
    const listRuns = taskTools[3]!;
    const created = await create.execute(
      { name: '运行', schedule: '0 9 * * *', action: 'x' },
      { sessionId: 's1' },
    );
    const task = (created.data as { task: { id: string } }).task;
    await deps.tasks.addRun({
      taskId: task.id,
      status: 'success',
      output: 'ok',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });

    const runs = await listRuns.execute({ taskId: task.id }, { sessionId: 's1' });
    const data = runs.data as { runs: Array<{ taskId: string }> };
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0]?.taskId).toBe(task.id);
  });
});
