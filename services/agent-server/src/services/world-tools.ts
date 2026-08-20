import type { WorldStore } from '@personal-ai/memory';
import type { Tool, ToolResult } from '@personal-ai/tools';
import type { WorldService } from './world-service.js';

/**
 * 「她的世界」工具（AI Town world model 的 Agent 视角）：
 * - world.state（L0）：她当前在哪个房间、在做什么、活了几天
 * - world.act（L1）：让她做一件事（可逆、非破坏，durationMin 后回到时段默认）
 * 权限依据：L0 只读世界状态；L1 仅改变她的活动，不涉及文件/系统/删除，
 * 微信通道可用（≤L1）。
 */

export interface WorldToolOptions {
  store: WorldStore;
  service: WorldService;
}

export function createWorldTools(options: WorldToolOptions): Tool[] {
  const { store, service } = options;

  return [
    {
      name: 'world.state',
      description:
        '查看「她的世界」（只读 L0）：她当前在哪个房间、正在做什么（含 emoji）、' +
        '已经活了几天、总行动次数。回答"你在哪/你在干嘛"类问题时先查这个。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionLevel: 0,
      async execute(): Promise<ToolResult> {
        const state = await store.getWorld();
        return { ok: true, data: state };
      },
    },
    {
      name: 'world.act',
      description:
        '让她做一件事（L1，可逆）：比如用户说"去床上躺着""去阳台吹风"，或她自己决定' +
        '换个状态。label 必填（做什么），可选 kind（sleeping/working/reading/eating/walking/' +
        'resting/chatting/custom）、emoji、location（卧室/客厅/书房/厨房/阳台）、durationMin' +
        '（保持分钟数，默认 30，最多 240）。到期后自动回到当前时段默认活动。',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', maxLength: 60, description: '在做什么，如「在床上躺着发呆」' },
          kind: {
            type: 'string',
            enum: ['sleeping', 'working', 'reading', 'eating', 'walking', 'resting', 'chatting', 'custom'],
            description: '活动类型，默认 custom',
          },
          emoji: { type: 'string', maxLength: 4, description: '展示用 emoji，默认 ✨' },
          location: { type: 'string', maxLength: 20, description: '位置：卧室/客厅/书房/厨房/阳台' },
          durationMin: { type: 'number', description: '保持分钟数，默认 30，最大 240' },
        },
        required: ['label'],
      },
      permissionLevel: 1,
      async execute(input: unknown): Promise<ToolResult> {
        const { label, kind, emoji, location, durationMin } = (input ?? {}) as {
          label?: string;
          kind?: 'sleeping' | 'working' | 'reading' | 'eating' | 'walking' | 'resting' | 'chatting' | 'custom';
          emoji?: string;
          location?: string;
          durationMin?: number;
        };
        if (!label?.trim()) return { ok: false, error: '缺少 label（她在做什么）' };
        const state = await service.act({
          label,
          kind,
          emoji,
          location,
          durationMin,
        });
        return { ok: true, data: { applied: true, state } };
      },
    },
  ];
}
