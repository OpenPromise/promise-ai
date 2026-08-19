import { describe, expect, it } from 'vitest';
import { formatEvent } from './event-pusher.js';

describe('formatEvent', () => {
  it('formats reminder.due', () => {
    expect(formatEvent('reminder.due', { text: '喝水' })).toBe('⏰ 提醒：喝水');
    expect(formatEvent('reminder.due', {})).toBe('⏰ 提醒：时间到了');
  });

  it('formats task.run success and error', () => {
    expect(formatEvent('task.run', { taskName: '备份', status: 'success', output: 'ok' })).toBe(
      '✅ 定时任务完成：备份\nok',
    );
    expect(formatEvent('task.run', { action: '清理', status: 'error', error: '磁盘满' })).toBe(
      '❌ 定时任务失败：清理\n磁盘满',
    );
  });

  it('ignores unknown events', () => {
    expect(formatEvent('something.else', {})).toBeUndefined();
  });
});
