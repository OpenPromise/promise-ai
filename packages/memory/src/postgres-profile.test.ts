import { afterAll, describe, expect, it } from 'vitest';
import { PostgresProfileStore } from './index.js';

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)('PostgresProfileStore', () => {
  const store = new PostgresProfileStore({ connectionString: connectionString as string });
  const userId = 'postgres-profile-concurrency-test';

  it('并发 upsertEntry 不同 key 不丢条目（per-user 串行队列消除读-改-写覆盖）', async () => {
    await store.init();

    const total = 20;
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        store.upsertEntry(userId, { key: `key-${i}`, value: `value-${i}`, category: 'fact' }),
      ),
    );

    const profile = await store.getProfile(userId);
    expect(profile?.entries.map((e) => e.key).sort()).toEqual(
      Array.from({ length: total }, (_, i) => `key-${i}`).sort(),
    );
    expect(profile?.entries).toHaveLength(total);
  });

  afterAll(async () => {
    await store.clear(userId);
    await store.close();
  });
});
