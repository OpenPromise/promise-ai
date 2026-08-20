import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectSecrets,
  createServerShellTool,
  redactOutput,
  type ShellRunner,
} from './server-shell.js';

function fakeRunner(): ShellRunner {
  return vi.fn(async (command, options) => {
    if (command === 'exit 1') {
      return { exitCode: 1, stdout: '', stderr: 'boom', timedOut: false };
    }
    return { exitCode: 0, stdout: `ran:${command} cwd:${options.cwd}`, stderr: '', timedOut: false };
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('server.shell（云服务器即她的世界）', () => {
  it('权限等级为 L3（系统级，微信通道默认拒绝）', () => {
    const tool = createServerShellTool();
    expect(tool.permissionLevel).toBe(3);
    expect(tool.name).toBe('server.shell');
  });

  it('缺少 command 时校验失败', async () => {
    const runner = fakeRunner();
    const tool = createServerShellTool({ runner, defaultCwd: process.cwd() });
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('command');
    expect(runner).not.toHaveBeenCalled();
  });

  it('在配置的默认工作区执行并返回输出（生产默认 /projects）', async () => {
    const runner = fakeRunner();
    const tool = createServerShellTool({ runner, defaultCwd: process.cwd() });
    const result = await tool.execute({ command: 'git clone https://github.com/x/y.git' }, {
      sessionId: 's1',
    });
    expect(result.ok).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      'git clone https://github.com/x/y.git',
      expect.objectContaining({ cwd: process.cwd() }),
    );
    expect((result.data as { stdout: string }).stdout).toContain(`cwd:${process.cwd()}`);
  });

  it('工作目录不存在时校验失败', async () => {
    const runner = fakeRunner();
    const tool = createServerShellTool({ runner, defaultCwd: process.cwd() });
    const result = await tool.execute(
      { command: 'pwd', cwd: '/definitely/not/exist/xyz' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('工作目录不存在');
    expect(runner).not.toHaveBeenCalled();
  });

  it('非零退出码仍返回结果并带 stderr（供模型自我纠错）', async () => {
    const runner = fakeRunner();
    const tool = createServerShellTool({ runner, defaultCwd: process.cwd() });
    const result = await tool.execute({ command: 'exit 1' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect((result.data as { exitCode: number }).exitCode).toBe(1);
    expect((result.data as { stderr: string }).stderr).toBe('boom');
  });

  it('超时上限 300 秒', async () => {
    const runner = fakeRunner();
    const tool = createServerShellTool({ runner, defaultCwd: process.cwd() });
    await tool.execute({ command: 'sleep 1', timeoutSeconds: 999 }, { sessionId: 's1' });
    expect(runner).toHaveBeenCalledWith(
      'sleep 1',
      expect.objectContaining({ timeoutMs: 300 * 1000 }),
    );
  });

  it('敏感密钥自动脱敏（防 bot 把密钥回显进会话）', async () => {
    vi.stubEnv('TEST_API_KEY', 'sk-test-secret-1234567890');
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'env output: sk-test-secret-1234567890 leaked',
      stderr: '',
      timedOut: false,
    }));
    const tool = createServerShellTool({ runner, defaultCwd: process.cwd() });
    const result = await tool.execute({ command: 'env' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    const stdout = (result.data as { stdout: string }).stdout;
    expect(stdout).toContain('[REDACTED]');
    expect(stdout).not.toContain('sk-test-secret-1234567890');
  });

  it('timedOut 标记与提示', async () => {
    const runner = vi.fn(async () => ({
      exitCode: 124,
      stdout: '',
      stderr: '',
      timedOut: true,
    }));
    const tool = createServerShellTool({ runner, defaultCwd: process.cwd() });
    const result = await tool.execute({ command: 'sleep 999' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect((result.data as { timedOut: boolean }).timedOut).toBe(true);
    expect((result.data as { note?: string }).note).toContain('进程树');
  });
});

describe('collectSecrets / redactOutput', () => {
  it('只收集密钥类环境变量，长的先替换', () => {
    const secrets = collectSecrets({
      DEEPSEEK_API_KEY: 'sk-long-secret-1234567890',
      DEEPSEEK_LLM_MODEL: 'deepseek-v4-flash',
      HOME: '/root',
      TENCENT_SECRET_ID: 'AKIDshort',
    });
    expect(secrets).toContain('sk-long-secret-1234567890');
    expect(secrets).toContain('AKIDshort');
    expect(secrets).not.toContain('deepseek-v4-flash');
    expect(secrets).not.toContain('/root');
    expect(secrets[0]).toBe('sk-long-secret-1234567890');
  });

  it('输出中的敏感值全部替换为 [REDACTED]', () => {
    const out = redactOutput('key=sk-abc-1234567890 and again sk-abc-1234567890', [
      'sk-abc-1234567890',
    ]);
    expect(out).toBe('key=[REDACTED] and again [REDACTED]');
  });
});
