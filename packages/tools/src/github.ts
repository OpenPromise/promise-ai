import type { Tool } from './index.js';

interface GitHubRepoItem {
  full_name?: string;
  description?: string | null;
  stargazers_count?: number;
  html_url?: string;
  language?: string | null;
  license?: { spdx_id?: string | null } | null;
}

/** 搜索 GitHub 仓库（按星标排序），用于查找可参考/集成的开源项目。 */
export function createGithubSearchTool(fetchImpl: typeof fetch = fetch): Tool {
  return {
    name: 'github.search_repos',
    description:
      '搜索 GitHub 仓库（按星标排序），返回仓库名/星标/语言/许可证/描述。' +
      '用于查找可参考或集成的开源项目；集成前先评估许可证与依赖。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（如 md5 生成 解码）' },
        limit: { type: 'number', description: '返回条数，默认 5，最大 10' },
      },
      required: ['query'],
    },
    permissionLevel: 0,
    timeoutMs: 20_000,
    async execute(input: unknown) {
      const { query, limit = 5 } = (input ?? {}) as { query?: string; limit?: number };
      if (!query?.trim()) return { ok: false, error: '缺少 query 参数' };
      try {
        const response = await fetchImpl(
          `https://api.github.com/search/repositories?q=${encodeURIComponent(query.trim())}&sort=stars&order=desc&per_page=${Math.min(Math.max(1, Math.floor(limit)), 10)}`,
          {
            headers: {
              accept: 'application/vnd.github+json',
              'user-agent': 'personal-ai-assistant',
            },
          },
        );
        if (!response.ok) {
          return { ok: false, error: `GitHub API 返回 ${response.status}` };
        }
        const data = (await response.json()) as { items?: GitHubRepoItem[] };
        const repos = (data.items ?? []).map((item) => ({
          full_name: item.full_name ?? '',
          stars: item.stargazers_count ?? 0,
          language: item.language ?? null,
          license: item.license?.spdx_id ?? null,
          description: item.description ?? '',
          url: item.html_url ?? `https://github.com/${item.full_name ?? ''}`,
        }));
        return { ok: true, data: { count: repos.length, repos } };
      } catch (error) {
        return {
          ok: false,
          error: `GitHub 搜索失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
