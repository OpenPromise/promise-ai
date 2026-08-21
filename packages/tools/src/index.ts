import { createCalendarTools, InMemoryCalendarStore } from './calendar.js';
import { createFilesystemSearchTool } from './filesystem.js';
import { createGoalTools } from './goal-tools.js';
import { createMemoryTools } from './memory-tools.js';
import { createGithubSearchTool, createGithubTools } from './github.js';
import { createReminderTools } from './reminders.js';
import { createTaskTools, type TaskToolDeps } from './task-tools.js';
import {
  createFilesystemDeleteTool,
  createNotificationSendTool,
  InMemoryNotificationStore,
} from './sensitive.js';
import type { MemoryStore, ReminderStore } from '@personal-ai/memory';
import { InMemoryMemoryStore, InMemoryReminderStore } from '@personal-ai/memory';
import { createTimeTool } from './time.js';
import { createWeatherTool } from './weather.js';
import { createWebSearchTool } from './web-search.js';
import { createWebFetchTool } from './web-fetch.js';

export type PermissionLevel = 0 | 1 | 2 | 3;

export interface ToolContext {
  sessionId: string;
  /** 一次用户请求的标识；任务级权限授权（Allow once 覆盖整个任务循环）以它为作用域。 */
  requestId?: string;
  deviceId?: string;
  userId?: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface JSONSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  permissionLevel: PermissionLevel;
  /** Per-call timeout in ms; defaults to the agent loop's 15s when unset. */
  timeoutMs?: number;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    // 下划线化（LLM wire 名）碰撞检测：engineer.delegate 与 engineer_delegate
    // 这类不同原始名会映射成同一个 wire 名，运行时静默顶替，这里注册期直接拒绝。
    const wireName = tool.name.replace(/\./g, '_');
    for (const existing of this.#tools.values()) {
      if (existing.name !== tool.name && existing.name.replace(/\./g, '_') === wireName) {
        throw new Error(
          `Tool wire name collision: ${tool.name} and ${existing.name} both map to ${wireName}`,
        );
      }
    }
    this.#tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  list(): Tool[] {
    return [...this.#tools.values()];
  }

  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }
}

export interface BuiltinToolOptions {
  /** Directories filesystem.search is allowed to traverse. */
  allowedSearchRoots?: string[];
  /** Injectable fetch implementation for weather/web.search. */
  fetchImpl?: typeof fetch;
  /** Long-term memory store used by memory.* tools. */
  memoryStore?: MemoryStore;
  /** Task store + session factory used by task.* tools. */
  tasks?: TaskToolDeps;
  /** Reminder store used by reminder.* tools (defaults to in-memory). */
  reminders?: ReminderStore;
}

export interface BuiltinToolStores {
  reminders: ReminderStore;
  calendar: InMemoryCalendarStore;
  notifications: InMemoryNotificationStore;
}

export interface BuiltinToolSet {
  tools: Tool[];
  stores: BuiltinToolStores;
}

/** Creates the first batch of built-in tools (Phase 5). */
export function createBuiltinTools(options: BuiltinToolOptions = {}): BuiltinToolSet {
  const stores: BuiltinToolStores = {
    reminders: options.reminders ?? new InMemoryReminderStore(),
    calendar: new InMemoryCalendarStore(),
    notifications: new InMemoryNotificationStore(),
  };
  const tools: Tool[] = [
    createTimeTool(),
    createWeatherTool(options.fetchImpl),
    createWebSearchTool(options.fetchImpl),
    createWebFetchTool(options.fetchImpl),
    createGithubSearchTool(options.fetchImpl),
    ...createGithubTools({ fetchImpl: options.fetchImpl }),
    createFilesystemSearchTool({ allowedRoots: options.allowedSearchRoots }),
    createFilesystemDeleteTool({ allowedRoots: options.allowedSearchRoots }),
    createNotificationSendTool(stores.notifications),
    ...createMemoryTools(options.memoryStore ?? new InMemoryMemoryStore()),
    ...createGoalTools(options.memoryStore ?? new InMemoryMemoryStore()),
    ...(options.tasks ? createTaskTools(options.tasks) : []),
    ...createReminderTools(stores.reminders),
    ...createCalendarTools(stores.calendar),
  ];
  return { tools, stores };
}

export { createTimeTool } from './time.js';
export { createWeatherTool } from './weather.js';
export { createWebSearchTool } from './web-search.js';
export { createFilesystemSearchTool, type CreateFilesystemSearchOptions } from './filesystem.js';
export { createReminderTools } from './reminders.js';
export { createCalendarTools, InMemoryCalendarStore, type CalendarEvent } from './calendar.js';
export {
  createFilesystemDeleteTool,
  createNotificationSendTool,
  InMemoryNotificationStore,
  type Notification,
} from './sensitive.js';
export { validateToolArgs, type ValidationIssue } from './validate.js';
export { createMemoryTools } from './memory-tools.js';
export { createGoalTools, GOAL_PREFIX, parseGoal } from './goal-tools.js';
export { createGithubSearchTool } from './github.js';
export { createTaskTools, type TaskToolDeps } from './task-tools.js';
