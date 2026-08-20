import type { AvatarWorldState } from '@personal-ai/memory';

/** 「她的世界」状态变更事件总线：心跳/换活动后广播，/world 页面实时同步。 */
export class WorldEventBus {
  readonly #listeners = new Set<(state: AvatarWorldState) => void>();

  subscribe(listener: (state: AvatarWorldState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(state: AvatarWorldState): void {
    for (const listener of this.#listeners) {
      try {
        listener(state);
      } catch {
        // 单个订阅者出错不影响其他
      }
    }
  }
}
