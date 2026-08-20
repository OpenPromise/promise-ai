import { describe, expect, it, vi } from 'vitest';
import { createServerShellTool, type ShellRunner } from './server-shell.js';

function fakeRunner(): ShellRunner {
  return vi.fn(async (command, options) => {
    if (command === 'exit 1') {
      return { exitCode: 1, stdout: '', stderr: 'boom' };
    }
    return { exitCode: 0, stdout: `ran:${command} cwd:${options.cwd}`, stderr: '' };
  });
}

describe('server.shell（云服务器即她的世界）', () => {
  it('权限等级为 L3（系统级，微信通道默认拒绝）', () => {
    const tool = createServerShellTool();
    expect(tool.permissionLevel).toBe(3);
    expect(tool.name).toBe('server.shell');
  });

  it('缺少 command 时校验失败', async () => {
    const runner = fakeRunner();
    const tool = createServerShellTool({ runner });
    const result = await tool.execute({}, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('command');
    expect(runner).not.toHaveBeenCalled();
  });

  it('默认在 /projects 持久工作区执行并返回输出', async () => {
    const runner = fakeRunner();
    const tool = createServerShellTool({ runner });
    const result = await tool.execute({ command: 'git clone https://github.com/x/y.git' }, {
      sessionId: 's1',
    });
    expect(result.ok).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      'git clone https://github.com/x/y.git',
      expect.objectContaining({ cwd: '/projects' }),
    );
    expect((result.data as { stdout: string }).stdout).toContain('cwd:/projects');
  });

  it('非零退出码仍返回结果并带 stderr（供模型自我纠错）', async () => {
    const runner = fakeRunner();
    const tool = createServerShellTool({ runner });
    const result = await tool.execute({ command: 'exit 1' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    expect((result.data as { exitCode: number }).exitCode).toBe(1);
    expect((result.data as { stderr: string }).stderr).toBe('boom');
  });

  it('超时上限 300 秒', async () => {
    const runner = fakeRunner();
    const tool = createServerShellTool({ runner });
    await tool.execute({ command: 'sleep 1', timeoutSeconds: 999 }, { sessionId: 's1' });
    expect(runner).toHaveBeenCalledWith(
      'sleep 1',
      expect.objectContaining({ timeoutMs: 300 * 1000 }),
    );
  });
});
