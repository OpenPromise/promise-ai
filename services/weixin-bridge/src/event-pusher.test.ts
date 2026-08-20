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

  it('formats system.boot（云服务器重启完成通知）', () => {
    expect(formatEvent('system.boot', { text: '云服务器重启完成' })).toBe(
      '✅ 云服务器重启完成，所有服务已自动恢复。',
    );
  });

  it('ignores unknown events', () => {
    expect(formatEvent('something.else', {})).toBeUndefined();
  });
});
