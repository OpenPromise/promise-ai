import { describe, expect, it, vi } from 'vitest';
import { createGithubTools } from './github.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('github.* 全流程工具', () => {
  it('github.issues 列出 issue（L0）', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse([
        {
          number: 12,
          title: '优化部署',
          state: 'open',
          labels: [{ name: 'enhancement' }],
          user: { login: 'alice' },
          created_at: '2026-08-01T00:00:00Z',
          html_url: 'https://github.com/OpenPromise/promise-ai/issues/12',
        },
      ]),
    );
    const tool = createGithubTools({ fetchImpl })[0]!;
    const result = await tool.execute({ repo: 'OpenPromise/promise-ai' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    const data = result.data as { issues: Array<{ number: number; labels: string[] }> };
    expect(data.issues[0]?.number).toBe(12);
    expect(data.issues[0]?.labels).toEqual(['enhancement']);
    expect(tool.permissionLevel).toBe(0);
  });

  it('github.create_issue 无 token 时明确报错', async () => {
    const fetchImpl = vi.fn();
    const tools = createGithubTools({ fetchImpl });
    const tool = tools.find((t) => t.name === 'github.create_issue')!;
    const result = await tool.execute(
      { repo: 'OpenPromise/promise-ai', title: '测试' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('GITHUB_TOKEN');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('github.create_issue 有 token 时真实创建（L1）', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse({ number: 99, title: '测试', html_url: 'https://github.com/x/y/issues/99' }, 201),
    );
    const tools = createGithubTools({ fetchImpl, token: 'ghp_test' });
    const tool = tools.find((t) => t.name === 'github.create_issue')!;
    expect(tool.permissionLevel).toBe(1);
    const result = await tool.execute(
      { repo: 'OpenPromise/promise-ai', title: '测试', labels: ['enhancement'] },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    expect((result.data as { number: number }).number).toBe(99);
    const call = fetchImpl.mock.calls[0]!;
    expect(String(call[0])).toContain('/issues');
    const init = call[1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: 'Bearer ghp_test' });
    expect(JSON.parse(String(init.body))).toMatchObject({ title: '测试' });
  });

  it('github.comment 发表评论（L1）', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse({ html_url: 'https://github.com/x/y/issues/5#issuecomment-1' }, 201),
    );
    const tools = createGithubTools({ fetchImpl, token: 'ghp_test' });
    const tool = tools.find((t) => t.name === 'github.comment')!;
    const result = await tool.execute(
      { repo: 'OpenPromise/promise-ai', issueNumber: 5, body: '收到' },
      { sessionId: 's1' },
    );
    expect(result.ok).toBe(true);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/issues/5/comments');
  });
});
