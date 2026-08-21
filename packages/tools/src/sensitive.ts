import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tool } from './index.js';

export interface Notification {
  id: string;
  text: string;
  createdAt: string;
}

export class InMemoryNotificationStore {
  readonly #items: Notification[] = [];

  add(text: string): Notification {
    const notification: Notification = {
      id: randomUUID(),
      text,
      createdAt: new Date().toISOString(),
    };
    this.#items.push(notification);
    return notification;
  }

  list(): Notification[] {
    return [...this.#items];
  }
}

export interface CreateSensitiveToolsOptions {
  /** Directories filesystem.delete is allowed to delete files inside. */
  allowedRoots?: string[];
  notifications?: InMemoryNotificationStore;
}

/**
 * Level 3 tool: deletes a single file inside an allowed root. The agent loop
 * requires two explicit user confirmations before this executes.
 */
export function createFilesystemDeleteTool(options: CreateSensitiveToolsOptions = {}): Tool {
  const allowedRoots = (options.allowedRoots ?? [process.cwd()]).map((root) => path.resolve(root));

  return {
    name: 'filesystem.delete',
    description:
      '删除工作区内的一个文件（L3：需要用户二次确认）。不会删除目录，且只允许删除允许根目录下的文件。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对于允许根目录的文件路径',
        },
      },
      required: ['path'],
    },
    permissionLevel: 3,
    async execute(input: unknown) {
      const { path: filePath } = (input ?? {}) as { path?: string };
      if (!filePath?.trim()) {
        return { ok: false, error: '缺少 path 参数' };
      }

      const target = path.resolve(allowedRoots[0] ?? process.cwd(), filePath);
      if (!allowedRoots.some((root) => isWithin(target, root))) {
        return { ok: false, error: '目标文件不在允许的工作区内' };
      }
      if (path.resolve(target) === path.resolve(allowedRoots[0] ?? '')) {
        return { ok: false, error: '不允许删除根目录' };
      }

      try {
        await unlink(target);
        return {
          ok: true,
          data: { deleted: path.relative(allowedRoots[0] ?? '', target).replace(/\\/g, '/') },
        };
      } catch (error) {
        return {
          ok: false,
          error: `删除失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * 通知工具：当前只记录到内存 store，没有任何主动投递通道（无桌面端，
 * 微信推送走 reminder.due / engineer.task.done 等事件链路，不走这里）。
 * 因此按"仅记录"语义降为 L1——保持 L2 却只写内存是误导：既拦用户又没效果。
 * 若未来接入真实投递通道，再回到 L2 并接审批。
 */
export function createNotificationSendTool(store = new InMemoryNotificationStore()): Tool {
  return {
    name: 'notification.send',
    description: '记录一条通知（仅保存在本机内存，不会主动推送）。L1：' +
      '如需真正提醒用户请用 reminder.create（会按时通过微信推送）。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '通知内容' },
      },
      required: ['text'],
    },
    permissionLevel: 1,
    async execute(input: unknown) {
      const { text } = (input ?? {}) as { text?: string };
      if (!text?.trim()) {
        return { ok: false, error: '缺少 text 参数' };
      }
      const notification = store.add(text.trim());
      return { ok: true, data: { notification } };
    },
  };
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
