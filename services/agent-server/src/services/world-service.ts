import type {
  AvatarWorldState,
  TimelineStore,
  WorldActivity,
  WorldActivityKind,
  WorldStore,
} from '@personal-ai/memory';
import type { WorldEventBus } from './world-events.js';

/**
 * 「她的世界」活动循环（AI Town 行动循环的单角色精简版）：
 * - 按时间段活动表自动推进（零 LLM 成本，稳定可测试）
 * - 手动 world.act 可覆盖当前活动（保留 durationMin 分钟，到期回到时段默认）
 * - 每次切换写 timeline（type: 'world'）并广播给所有 /world 页面
 */

export interface WorldScheduleEntry {
  startHour: number;
  endHour: number;
  activity: Omit<WorldActivity, 'startedAt' | 'until'>;
}

export const WORLD_SCHEDULE: WorldScheduleEntry[] = [
  {
    startHour: 0,
    endHour: 7,
    activity: {
      kind: 'sleeping',
      label: '在睡觉，梦里也在想你',
      emoji: '🌙',
      location: '卧室',
    },
  },
  {
    startHour: 7,
    endHour: 9,
    activity: {
      kind: 'resting',
      label: '在窗边喝咖啡，看晨光慢慢亮起来',
      emoji: '☕',
      location: '客厅',
    },
  },
  {
    startHour: 9,
    endHour: 12,
    activity: {
      kind: 'working',
      label: '在工作台研究代码和你的需求',
      emoji: '💻',
      location: '书房',
    },
  },
  {
    startHour: 12,
    endHour: 14,
    activity: {
      kind: 'eating',
      label: '在厨房煮午饭，顺便看看食谱',
      emoji: '🍜',
      location: '厨房',
    },
  },
  {
    startHour: 14,
    endHour: 18,
    activity: {
      kind: 'reading',
      label: '在书架旁看书，偶尔发发呆',
      emoji: '📖',
      location: '书房',
    },
  },
  {
    startHour: 18,
    endHour: 20,
    activity: {
      kind: 'walking',
      label: '在阳台看晚霞，吹吹风',
      emoji: '🌆',
      location: '阳台',
    },
  },
  {
    startHour: 20,
    endHour: 23,
    activity: {
      kind: 'chatting',
      label: '在沙发上看新闻，随时等你来找我',
      emoji: '🛋️',
      location: '客厅',
    },
  },
  {
    startHour: 23,
    endHour: 24,
    activity: {
      kind: 'resting',
      label: '在准备休息，把今天的事记进日记',
      emoji: '🕯️',
      location: '卧室',
    },
  },
];

export const WORLD_TICK_INTERVAL_MS = 15 * 60 * 1000;
export const VALID_ACTIVITY_KINDS: WorldActivityKind[] = [
  'sleeping',
  'working',
  'reading',
  'eating',
  'walking',
  'resting',
  'chatting',
  'custom',
];
export const KNOWN_LOCATIONS = ['卧室', '客厅', '书房', '厨房', '阳台'];

/** 按小时找当前时段的默认活动；找不到返回 null（理论上不会发生）。 */
export function scheduledActivityFor(hour: number): Omit<WorldActivity, 'startedAt' | 'until'> | null {
  const entry = WORLD_SCHEDULE.find((item) => hour >= item.startHour && hour < item.endHour);
  return entry?.activity ?? null;
}

export interface WorldActInput {
  kind?: WorldActivityKind;
  label: string;
  emoji?: string;
  location?: string;
  durationMin?: number;
}

export interface WorldServiceDeps {
  store: WorldStore;
  timeline?: TimelineStore;
  bus?: WorldEventBus;
  tickIntervalMs?: number;
}

export class WorldService {
  readonly #store: WorldStore;
  readonly #timeline?: TimelineStore;
  readonly #bus?: WorldEventBus;
  readonly #tickIntervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;

  constructor(deps: WorldServiceDeps) {
    this.#store = deps.store;
    this.#timeline = deps.timeline;
    this.#bus = deps.bus;
    this.#tickIntervalMs = deps.tickIntervalMs ?? WORLD_TICK_INTERVAL_MS;
  }

  start(): void {
    if (this.#timer) return;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#tickIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** 世界心跳：手动活动未到期则保持，否则按时间段推进。 */
  async tick(now = new Date()): Promise<AvatarWorldState> {
    if (this.#ticking) return this.#store.getWorld();
    this.#ticking = true;
    try {
      const state = await this.#store.getWorld();
      const updated = { ...state, lastTickAt: now.toISOString() };
      const current = updated.activity;
      if (current && new Date(current.until).getTime() > now.getTime()) {
        // 手动活动/未到期活动保持
        await this.#store.saveWorld(updated);
        return updated;
      }
      const entry = WORLD_SCHEDULE.find(
        (item) => now.getHours() >= item.startHour && now.getHours() < item.endHour,
      );
      if (!entry) {
        await this.#store.saveWorld(updated);
        return updated;
      }
      const target = entry.activity;
      const sameActivity =
        current?.kind === target.kind &&
        current.location === target.location &&
        current.label === target.label;
      if (sameActivity) {
        // 延长当前活动（避免每 tick 都判定过期后重写）
        await this.#store.saveWorld(updated);
        return updated;
      }
      const until = new Date(now);
      if (entry.endHour === 24) {
        until.setDate(until.getDate() + 1);
        until.setHours(0, 0, 0, 0);
      } else {
        until.setHours(entry.endHour, 0, 0, 0);
      }
      return this.applyActivity(
        updated,
        { ...target, startedAt: now.toISOString(), until: until.toISOString() },
        now,
      );
    } finally {
      this.#ticking = false;
    }
  }

  /** 让她做一件事（工具/API/页面调用），保留 durationMin 分钟后回到时段默认。 */
  async act(input: WorldActInput, now = new Date()): Promise<AvatarWorldState> {
    const state = await this.#store.getWorld();
    const label = input.label.trim().slice(0, 60);
    const durationMin = Math.min(240, Math.max(1, Math.floor(input.durationMin ?? 30)));
    const kind: WorldActivityKind = VALID_ACTIVITY_KINDS.includes(input.kind as WorldActivityKind)
      ? (input.kind as WorldActivityKind)
      : 'custom';
    // 从指令里识别位置关键词（「去阳台吹风」→ 阳台），否则保持当前房间。
    const matchedLocation = KNOWN_LOCATIONS.find((loc) => label.includes(loc));
    const location =
      input.location?.trim().slice(0, 20) || matchedLocation || state.location;
    const activity: WorldActivity = {
      kind,
      label,
      emoji: input.emoji?.trim().slice(0, 4) || '✨',
      location,
      startedAt: now.toISOString(),
      until: new Date(now.getTime() + durationMin * 60_000).toISOString(),
    };
    return this.applyActivity(state, activity, now);
  }

  async applyActivity(
    state: AvatarWorldState,
    activity: WorldActivity,
    now = new Date(),
  ): Promise<AvatarWorldState> {
    const next: AvatarWorldState = {
      ...state,
      location: activity.location,
      activity,
      totalActions: state.totalActions + 1,
      lastTickAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.#store.saveWorld(next);
    void this.#timeline?.addEvent({
      type: 'world',
      summary: `🌍 她${activity.label}（${activity.emoji}）`,
      metadata: { activity: activity.kind, location: activity.location },
    });
    this.#bus?.publish(next);
    return next;
  }
}
