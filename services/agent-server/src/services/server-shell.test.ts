import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyShellExit,
  collectSecrets,
  createServerShellTool,
  normalizePtyOutput,
  redactOutput,
  serverShellEnv,
  shellSingleQuote,
  type ShellOutput,
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

  // N-P1-1：上层超时/用户中断必须真正传到子进程（否则命令在容器里继续跑）
  it('context.signal abort 时把取消传给 runner，并按"取消"而非"超时"上报', async () => {
    const runner: ShellRunner = vi.fn(
      (_command, options) =>
        new Promise<ShellOutput>((resolve) => {
          const finish = (): void =>
            resolve({ exitCode: 130, stdout: '', stderr: '', timedOut: false, cancelled: true });
          if (options.signal.aborted) finish();
          else options.signal.addEventListener('abort', finish, { once: true });
        }),
    );
    const tool = createServerShellTool({ runner, defaultCwd: process.cwd() });
    const controller = new AbortController();
    const pending = tool.execute(
      { command: 'sleep 999' },
      { sessionId: 's1', signal: controller.signal },
    );
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(true);
    const data = result.data as { timedOut: boolean; cancelled?: boolean; note?: string };
    expect(data.cancelled).toBe(true);
    expect(data.timedOut).toBe(false);
    expect(data.note).toContain('取消');
  });

  it('context.signal 已 abort 时 runner 收到的 signal 也已 abort', async () => {
    let sawAborted: boolean | undefined;
    const runner: ShellRunner = vi.fn(async (_command, options) => {
      sawAborted = options.signal.aborted;
      return { exitCode: 130, stdout: '', stderr: '', timedOut: false, cancelled: true };
    });
    const tool = createServerShellTool({ runner, defaultCwd: process.cwd() });
    await tool.execute(
      { command: 'pwd' },
      { sessionId: 's1', signal: AbortSignal.abort() },
    );
    expect(sawAborted).toBe(true);
  });

  // N-P2-7：排队等待超时，不再让用户端"卡住不回"
  it('前一条命令占用队列超过等待上限时返回"服务器正忙"，且不重复执行', async () => {
    let release: (() => void) | undefined;
    let runnerCalls = 0;
    const runner: ShellRunner = vi.fn(
      () => {
        runnerCalls += 1;
        if (runnerCalls === 1) {
          return new Promise<ShellOutput>((resolve) => {
            release = () => resolve({ exitCode: 0, stdout: 'done', stderr: '', timedOut: false });
          });
        }
        return Promise.resolve({ exitCode: 0, stdout: 'done', stderr: '', timedOut: false });
      },
    );
    const tool = createServerShellTool({
      runner,
      defaultCwd: process.cwd(),
      queueWaitMs: 20,
    });
    // N-P2-7 后队列按会话分片：同一会话内排队超时才返回"忙"，不同会话互不阻塞
    const first = tool.execute({ command: 'sleep 10' }, { sessionId: 's1' });
    const second = await tool.execute({ command: 'pwd' }, { sessionId: 's1' });
    expect(second.ok).toBe(false);
    expect(second.error).toContain('服务器正忙');
    expect(runner).toHaveBeenCalledTimes(1);
    release?.();
    await first;
    expect(runner).toHaveBeenCalledTimes(1);

    // 不同会话的命令不被占用中的其它会话阻塞
    const other = await tool.execute({ command: 'pwd' }, { sessionId: 's2' });
    expect(other.ok).toBe(true);
  });
});

describe('serverShellEnv（N-P1-1 环境变量白名单）', () => {
  it('只透传 PATH/HOME/LANG 等基础变量，不把密钥与数据库连接串交给 bash', () => {
    const env = serverShellEnv({
      PATH: '/usr/bin',
      HOME: '/root',
      LANG: 'C.UTF-8',
      TZ: 'Asia/Shanghai',
      TERM: 'xterm',
      HTTPS_PROXY: 'http://host.docker.internal:7890',
      http_proxy: 'http://host.docker.internal:7890',
      NO_PROXY: 'localhost,.cn',
      DATABASE_URL: 'postgres://user:pass@db/app',
      OPENROUTER_API_KEY: 'sk-secret',
      DASHSCOPE_API_KEY: 'sk-dashscope',
      HOOK_SECRET: 'hook-secret',
      AGENT_API_TOKEN: 'agent-token',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/root',
      LANG: 'C.UTF-8',
      TZ: 'Asia/Shanghai',
      TERM: 'xterm',
      HTTPS_PROXY: 'http://host.docker.internal:7890',
      http_proxy: 'http://host.docker.internal:7890',
      NO_PROXY: 'localhost,.cn',
    });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('缺少 PATH 时回落到标准系统路径', () => {
    expect(serverShellEnv({}).PATH).toContain('/usr/bin');
  });
});

describe('classifyShellExit（N-P1-1 超时与取消分开上报）', () => {
  it('定时器触发 → timedOut，退出码 124', () => {
    expect(classifyShellExit({ code: null, signal: 'SIGTERM', timedOut: true, cancelled: false }))
      .toEqual({ exitCode: 124, timedOut: true, cancelled: false });
  });

  it('外部取消 → cancelled，不报成超时', () => {
    expect(classifyShellExit({ code: null, signal: 'SIGTERM', timedOut: false, cancelled: true }))
      .toEqual({ exitCode: 130, timedOut: false, cancelled: true });
  });

  it('正常结束保留原始退出码', () => {
    expect(classifyShellExit({ code: 3, signal: null, timedOut: false, cancelled: false })).toEqual({
      exitCode: 3,
      timedOut: false,
      cancelled: false,
    });
  });

  it('被第三方 kill（非我方超时/取消）不谎报超时', () => {
    expect(classifyShellExit({ code: null, signal: 'SIGKILL', timedOut: false, cancelled: false }))
      .toEqual({ exitCode: 137, timedOut: false, cancelled: false });
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
