import { createCalendarTools, InMemoryCalendarStore } from './calendar.js';
import { createFilesystemSearchTool } from './filesystem.js';
import { createMemoryTools } from './memory-tools.js';
import { createReminderTools, InMemoryReminderStore } from './reminders.js';
import { createTaskTools, type TaskToolDeps } from './task-tools.js';
import {
  createFilesystemDeleteTool,
  createNotificationSendTool,
  InMemoryNotificationStore,
} from './sensitive.js';
import type { MemoryStore } from '@personal-ai/memory';
import { InMemoryMemoryStore } from '@personal-ai/memory';
import { createTimeTool } from './time.js';
import { createWeatherTool } from './weather.js';
import { createWebSearchTool } from './web-search.js';

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

/** Tool declaration a desktop agent sends over /ws/desktop when connecting. */
export interface DesktopToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  permissionLevel: PermissionLevel;
  timeoutMs?: number;
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
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
}

export interface BuiltinToolStores {
  reminders: InMemoryReminderStore;
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
    reminders: new InMemoryReminderStore(),
    calendar: new InMemoryCalendarStore(),
    notifications: new InMemoryNotificationStore(),
  };
  const tools: Tool[] = [
    createTimeTool(),
    createWeatherTool(options.fetchImpl),
    createWebSearchTool(options.fetchImpl),
    createFilesystemSearchTool({ allowedRoots: options.allowedSearchRoots }),
    createFilesystemDeleteTool({ allowedRoots: options.allowedSearchRoots }),
    createNotificationSendTool(stores.notifications),
    ...createMemoryTools(options.memoryStore ?? new InMemoryMemoryStore()),
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
export { createReminderTools, InMemoryReminderStore, type Reminder } from './reminders.js';
export { createCalendarTools, InMemoryCalendarStore, type CalendarEvent } from './calendar.js';
export {
  createFilesystemDeleteTool,
  createNotificationSendTool,
  InMemoryNotificationStore,
  type Notification,
} from './sensitive.js';
export { validateToolArgs, type ValidationIssue } from './validate.js';
export { createMemoryTools } from './memory-tools.js';
export { createTaskTools, type TaskToolDeps } from './task-tools.js';
