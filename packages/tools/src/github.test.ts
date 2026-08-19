import { describe, expect, it, vi } from 'vitest';
import { createGithubSearchTool } from './github.js';

describe('github.search_repos', () => {
  it('searches repositories and maps fields', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(String(_input)).toContain('/search/repositories?q=md5');
      expect((init?.headers as Record<string, string>)?.accept).toContain('github+json');
      return new Response(
        JSON.stringify({
          items: [
            {
              full_name: 'owner/md5-tool',
              stargazers_count: 1234,
              language: 'Go',
              license: { spdx_id: 'MIT' },
              description: 'MD5 生成与破解',
              html_url: 'https://github.com/owner/md5-tool',
            },
          ],
        }),
        { status: 200 },
      );
    });
    const tool = createGithubSearchTool(fetchImpl as unknown as typeof fetch);
    const result = await tool.execute({ query: 'md5' }, { sessionId: 's1' });
    expect(result.ok).toBe(true);
    const repos = (result.data as { repos: Array<{ full_name: string; license: string }> }).repos;
    expect(repos[0]).toMatchObject({ full_name: 'owner/md5-tool', license: 'MIT' });
  });

  it('reports API errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 403 }));
    const tool = createGithubSearchTool(fetchImpl as unknown as typeof fetch);
    const result = await tool.execute({ query: 'md5' }, { sessionId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('403');
  });
});
