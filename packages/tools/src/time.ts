import type { Tool } from './index.js';

interface TimeInput {
  timezone?: string;
  format?: 'full' | 'date' | 'time';
}

const DATE_FORMATS: Record<NonNullable<TimeInput['format']>, Intl.DateTimeFormatOptions> = {
  full: {
    dateStyle: 'full',
    timeStyle: 'long',
  },
  date: {
    dateStyle: 'full',
  },
  time: {
    timeStyle: 'medium',
  },
};

export function createTimeTool(): Tool {
  return {
    name: 'time.get',
    description: '获取当前日期和时间。可指定 IANA 时区（如 Asia/Shanghai）与输出格式。',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA 时区标识，如 Asia/Shanghai、UTC',
        },
        format: {
          type: 'string',
          enum: ['full', 'date', 'time'],
          description: '输出格式：full（默认）完整日期时间 / date 仅日期 / time 仅时间',
        },
      },
      required: [],
    },
    permissionLevel: 0,
    async execute(input: unknown) {
      const { timezone, format = 'full' } = (input ?? {}) as TimeInput;
      const now = new Date();
      try {
        const options: Intl.DateTimeFormatOptions = {
          ...(DATE_FORMATS[format] ?? DATE_FORMATS.full),
          ...(timezone ? { timeZone: timezone } : {}),
        };
        const text = new Intl.DateTimeFormat('zh-CN', options).format(now);
        return {
          ok: true,
          data: {
            iso: now.toISOString(),
            timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
            text,
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: `无效的时区：${timezone}（${error instanceof Error ? error.message : String(error)}）`,
        };
      }
    },
  };
}
