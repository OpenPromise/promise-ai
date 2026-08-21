import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectSecrets,
  createServerShellTool,
  normalizePtyOutput,
  redactOutput,
  shellSingleQuote,
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

  it('interactive=true 时用 script 分配 PTY 并清理控制字符', async () => {
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'Progress: \x1b[32m100%\x1b[0m\r\nDone\r',
      stderr: '',
      timedOut: false,
    }));
    const tool = createServerShellTool({ runner, defaultCwd: process.cwd() });
    const result = await tool.execute(
      { command: 'apt-get install -y x', interactive: true },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      `script -qec ${shellSingleQuote('apt-get install -y x')} /dev/null`,
      expect.anything(),
    );
    const stdout = (result.data as { stdout: string }).stdout;
    expect(stdout).toContain('Progress: 100%');
    expect(stdout).not.toContain('\x1b');
    expect(stdout).not.toContain('\r');
  });

  it('input 参数透传给命令标准输入（交互式提示应答）', async () => {
    const runner = vi.fn(async (_command: string, options: { input?: string }) => ({
      exitCode: 0,
      stdout: `got:${options.input ?? ''}`,
      stderr: '',
      timedOut: false,
    }));
    const tool = createServerShellTool({ runner, defaultCwd: process.cwd() });
    const result = await tool.execute(
      { command: 'read -p "name: " x; echo hi $x', input: '夜夜\n' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      'read -p "name: " x; echo hi $x',
      expect.objectContaining({ input: '夜夜\n' }),
    );
    expect((result.data as { stdout: string }).stdout).toContain('got:夜夜');
  });

  it('sandbox=true 时用隔离容器包装命令', async () => {
    const runner = vi.fn(async (command: string) => ({
      exitCode: 0,
      stdout: `wrapped:${command.slice(0, 80)}`,
      stderr: '',
      timedOut: false,
    }));
    const tool = createServerShellTool({ runner, defaultCwd: process.cwd() });
    const result = await tool.execute(
      { command: 'rm -rf /tmp/x', sandbox: true },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('docker run --rm --network none --memory 256m'),
      expect.anything(),
    );
    expect((result.data as { stdout: string }).stdout).toContain('docker run');
  });

  it('sandbox 与 interactive 同时使用时报错', async () => {
    const runner = vi.fn();
    const tool = createServerShellTool({ runner, defaultCwd: process.cwd() });
    const result = await tool.execute(
      { command: 'read x', sandbox: true, interactive: true },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不能同时使用');
    expect(runner).not.toHaveBeenCalled();
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

  it('短密钥（<8 字符）也纳入脱敏', () => {
    const secrets = collectSecrets({
      DB_PASSWORD: 'p@ss',
      WEIXIN_TOKEN: 'ab',
      USE_TOKEN: 'true',
    });
    expect(secrets).toContain('p@ss');
    // 1–3 字符与开关型取值不脱敏：替换后会大面积污染无关输出
    expect(secrets).not.toContain('ab');
    expect(secrets).not.toContain('true');
    expect(redactOutput('psql: password=p@ss', secrets)).toBe('psql: password=[REDACTED]');
  });

  it('输出中的敏感值全部替换为 [REDACTED]', () => {
    const out = redactOutput('key=sk-abc-1234567890 and again sk-abc-1234567890', [
      'sk-abc-1234567890',
    ]);
    expect(out).toBe('key=[REDACTED] and again [REDACTED]');
  });
});

describe('PTY 辅助函数', () => {
  it('shellSingleQuote 正确处理命令中的单引号', () => {
    expect(shellSingleQuote("echo it's ok")).toBe("'echo it'\\''s ok'");
    expect(shellSingleQuote('echo hi')).toBe("'echo hi'");
  });

  it('normalizePtyOutput 去掉 CR 与 ANSI 控制序列', () => {
    const out = normalizePtyOutput('\x1b[1;32mOK\x1b[0m\r\nline2\r');
    expect(out).toBe('OK\nline2\n');
  });
});
