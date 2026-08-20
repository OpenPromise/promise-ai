import type { AvatarSnapshot } from '@personal-ai/memory';

/** Avatar 状态变更事件总线：进化/调整/换装后广播，所有打开的 /avatar 页面实时同步。 */
export class AvatarEventBus {
  readonly #listeners = new Set<(snapshot: AvatarSnapshot) => void>();

  subscribe(listener: (snapshot: AvatarSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(snapshot: AvatarSnapshot): void {
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // 单个订阅者出错不影响其他
      }
    }
  }
}
