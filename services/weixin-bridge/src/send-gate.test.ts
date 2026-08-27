import { describe, expect, it, vi } from 'vitest';
import { SEND_MIN_GAP_MS, SendGate } from './send-gate.js';

function createFakeClock() {
  let now = 0;
  const waits: Array<{ at: number; resolve: () => void }> = [];
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        waits.push({ at: now + ms, resolve });
      }),
    async advance(ms: number) {
      now += ms;
      const due = waits.filter((w) => w.at <= now).sort((a, b) => a.at - b.at);
      const rest = waits.filter((w) => w.at > now);
      waits.length = 0;
      waits.push(...rest);
      for (const w of due) w.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('SendGate', () => {
  it('overlapping run() calls execute strictly sequential', async () => {
    const gate = new SendGate({ minGapMs: 0 });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = gate.run(async () => {
      order.push('first-start');
      await firstHold;
      order.push('first-end');
    });
    const second = gate.run(async () => {
      order.push('second');
    });

    await vi.waitFor(() => expect(order).toEqual(['first-start']));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('waits SEND_MIN_GAP_MS after each attempt before the next (fake clock)', async () => {
    const clock = createFakeClock();
    const gate = new SendGate({ minGapMs: SEND_MIN_GAP_MS, clock });
    const order: string[] = [];

    const first = gate.run(async () => {
      order.push('a');
    });
    const second = gate.run(async () => {
      order.push('b');
    });

    await vi.waitFor(() => expect(order).toEqual(['a']));
    await clock.advance(SEND_MIN_GAP_MS - 1);
    expect(order).toEqual(['a']);
    await clock.advance(1);
    await Promise.all([first, second]);
    expect(order).toEqual(['a', 'b']);
  });
});
