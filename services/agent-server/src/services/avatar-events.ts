import type { AvatarGenome } from '@personal-ai/memory';

/** Avatar 状态变更事件总线：进化/调整后广播，所有打开的 /avatar 页面实时同步。 */
export class AvatarEventBus {
  readonly #listeners = new Set<(genome: AvatarGenome) => void>();

  subscribe(listener: (genome: AvatarGenome) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(genome: AvatarGenome): void {
    for (const listener of this.#listeners) {
      try {
        listener(genome);
      } catch {
        // 单个订阅者出错不影响其他
      }
    }
  }
}
