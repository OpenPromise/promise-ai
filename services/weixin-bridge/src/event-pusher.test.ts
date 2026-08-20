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

  it('HEARTBEAT_OK 静默跳过（不打扰协议）', () => {
    expect(
      formatEvent('task.run', { taskName: '服务器巡检', status: 'success', output: 'HEARTBEAT_OK' }),
    ).toBeUndefined();
    expect(
      formatEvent('task.run', {
        taskName: '服务器巡检',
        status: 'success',
        output: '磁盘使用率 95%，需要处理',
      }),
    ).toContain('磁盘使用率');
  });

  it('formats system.boot（云服务器重启完成通知）', () => {
    expect(formatEvent('system.boot', { text: '云服务器重启完成' })).toBe(
      '✅ 云服务器重启完成，所有服务已自动恢复。',
    );
  });

  it('formats engineer.task.progress（小黑后台进度）', () => {
    expect(
      formatEvent('engineer.task.progress', {
        type: 'progress',
        taskId: '12345678-aaaa',
        status: 'running',
        text: '正在跑测试',
      }),
    ).toBe('🔧 小黑任务进行中（#12345678）：正在跑测试');
  });

  it('formats engineer.task.done success and failure', () => {
    expect(
      formatEvent('engineer.task.done', {
        type: 'done',
        taskId: '12345678-aaaa',
        status: 'success',
        result: '【验证结果】typecheck 通过',
      }),
    ).toBe('✅ 小黑任务完成（#12345678）\n【验证结果】typecheck 通过');
    expect(
      formatEvent('engineer.task.done', {
        type: 'done',
        taskId: '12345678-aaaa',
        status: 'failed',
        error: '编译失败',
      }),
    ).toBe('❌ 小黑任务失败（#12345678）\n编译失败');
  });

  it('ignores unknown events', () => {
    expect(formatEvent('something.else', {})).toBeUndefined();
  });
});
