import { describe, expect, it, vi } from 'vitest';
import { createSystemStatusTool, minimalStatusEnv, parseSystemStatus } from './system-status.js';

const HEALTHY_OUTPUT = [
  'DISK_START',
  '/dev/vda2 40G 18G 22G 45% /',
  'DISK_END',
  'MEM_START',
  'Mem: 3944 1200 2744 0 0 2500',
  'Swap: 0 0 0',
  'MEM_END',
  'LOAD_START',
  '0.10 0.05 0.01 1/123 456',
  'LOAD_END',
  'UPTIME_START',
  '86400 123',
  'UPTIME_END',
  'DOCKER_START',
  'assistant-app|Up 2 hours (healthy)',
  'assistant-weixin|Up 2 hours (healthy)',
  'assistant-postgres|Up 2 hours (healthy)',
  'DOCKER_END',
].join('\n');

describe('parseSystemStatus', () => {
  it('解析健康输出并给出摘要', () => {
    const status = parseSystemStatus(HEALTHY_OUTPUT);
    expect(status.healthy).toBe(true);
    expect(status.issues).toEqual([]);
    expect(status.disk.usedPct).toBe(45);
    expect(status.memory.usedPct).toBe(30);
    expect(status.load.one).toBeCloseTo(0.1);
    expect(status.uptimeSeconds).toBe(86400);
    expect(status.containers).toHaveLength(3);
    expect(status.containers[0]?.unhealthy).toBe(false);
    expect(status.summary).toContain('✅ 全部正常');
  });

  it('磁盘>90%、容器不健康时标记异常', () => {
    const output = HEALTHY_OUTPUT.replace('45% /', '93% /').replace(
      'assistant-postgres|Up 2 hours (healthy)',
      'assistant-postgres|Restarting (1) 2 minutes ago',
    );
    const status = parseSystemStatus(output);
    expect(status.healthy).toBe(false);
    expect(status.issues.some((issue) => issue.includes('磁盘使用率 93%'))).toBe(true);
    expect(status.issues.some((issue) => issue.includes('assistant-postgres'))).toBe(true);
    expect(status.summary).toContain('⚠');
  });
});

describe('system.status 工具', () => {
  it('权限 L0 且返回结构化数据', async () => {
    const runner = vi.fn(async () => ({ stdout: HEALTHY_OUTPUT, stderr: '', exitCode: 0 }));
    const tool = createSystemStatusTool({ runner });
    expect(tool.permissionLevel).toBe(0);
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect((result.data as { healthy: boolean }).healthy).toBe(true);
    expect(runner).toHaveBeenCalledOnce();
  });

  it('脚本执行失败时返回可读错误', async () => {
    const runner = vi.fn(async () => {
      throw new Error('bash not found');
    });
    const tool = createSystemStatusTool({ runner });
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('bash not found');
  });

  it('把 context.signal 透传给 runner，上层取消能真正中断子进程', async () => {
    let observed: AbortSignal | undefined;
    const runner = vi.fn(
      async (_script: string, options: { timeoutMs: number; signal: AbortSignal }) => {
        observed = options.signal;
        return { stdout: HEALTHY_OUTPUT, stderr: '', exitCode: 0 };
      },
    );
    const tool = createSystemStatusTool({ runner });
    const parent = new AbortController();
    const result = await tool.execute({}, { sessionId: 's1', signal: parent.signal });
    expect(result.ok).toBe(true);
    expect(observed).toBeDefined();
    expect(runner.mock.calls[0]?.[1]?.timeoutMs).toBeGreaterThan(0);
    // execute 返回后子进程 signal 已 abort（幂等清理，不留孤儿）
    expect(observed?.aborted).toBe(true);
  });

  it('execute 前父 signal 已取消时，runner 收到的 signal 也是已取消的', async () => {
    let aborted: boolean | undefined;
    const runner = vi.fn(
      async (_script: string, options: { timeoutMs: number; signal: AbortSignal }) => {
        aborted = options.signal.aborted;
        return { stdout: '', stderr: '', exitCode: 124, timedOut: true };
      },
    );
    const tool = createSystemStatusTool({ runner });
    const parent = new AbortController();
    parent.abort();
    const result = await tool.execute({}, { sessionId: 's1', signal: parent.signal });
    expect(aborted).toBe(true);
    // 无任何输出 + timedOut：报告终止而不是解析出一份全 0 的假状态
    expect(result.ok).toBe(false);
    expect(result.error).toContain('终止进程树');
  });
});

describe('minimalStatusEnv', () => {
  it('只保留 PATH/HOME/LANG/TZ，不透传密钥与数据库连接串', () => {
    const env = minimalStatusEnv({
      PATH: '/usr/bin',
      HOME: '/root',
      LANG: 'C.UTF-8',
      TZ: 'Asia/Shanghai',
      DATABASE_URL: 'postgres://user:pass@db/app',
      OPENROUTER_API_KEY: 'sk-secret',
      HOOK_SECRET: 'hook-secret',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/root',
      LANG: 'C.UTF-8',
      TZ: 'Asia/Shanghai',
    });
  });

  it('缺少 PATH 时给出可用默认值', () => {
    expect(minimalStatusEnv({}).PATH).toContain('/usr/bin');
  });
});
