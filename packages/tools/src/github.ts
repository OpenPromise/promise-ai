import type { Tool } from './index.js';

export interface GithubToolOptions {
  fetchImpl?: typeof fetch;
  /** GitHub API Token（读写操作必需）；缺省读环境变量 GITHUB_TOKEN。 */
  token?: string;
}

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

interface GitHubIssueItem {
  number?: number;
  title?: string;
  state?: string;
  labels?: Array<{ name?: string }>;
  user?: { login?: string };
  created_at?: string;
  html_url?: string;
}

function parseRepo(repo: string): { owner: string; name: string } | null {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repo.trim());
  if (!match) return null;
  return { owner: match[1]!, name: match[2]! };
}

/**
 * GitHub 全流程工具（参考项目均无现成实现，自研）：
 * github.issues 只读 L0；github.create_issue / github.comment 写入 L1
 * （description 标注会真实写入 GitHub；需要 GITHUB_TOKEN）。
 */
export function createGithubTools(options: GithubToolOptions = {}): Tool[] {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.token ?? process.env.GITHUB_TOKEN;
  const authHeaders = token
    ? { authorization: `Bearer ${token}` }
    : {};

  return [
    {
      name: 'github.issues',
      description:
        '列出 GitHub 仓库的 issue（只读 L0）：按状态/label 过滤，返回标题/编号/状态/作者/时间。',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: '仓库，如 OpenPromise/promise-ai' },
          state: {
            type: 'string',
            enum: ['open', 'closed', 'all'],
            description: 'issue 状态，默认 open',
          },
          labels: { type: 'string', description: '逗号分隔的 label 过滤（可选）' },
          limit: { type: 'number', description: '返回条数，默认 10，最大 30' },
        },
        required: ['repo'],
      },
      permissionLevel: 0,
      timeoutMs: 20_000,
      async execute(input: unknown) {
        const { repo, state = 'open', labels, limit = 10 } = (input ?? {}) as {
          repo?: string;
          state?: string;
          labels?: string;
          limit?: number;
        };
        const parsed = repo ? parseRepo(repo) : null;
        if (!parsed) return { ok: false, error: 'repo 格式应为 owner/name' };
        try {
          const url = new URL(
            `https://api.github.com/repos/${parsed.owner}/${parsed.name}/issues`,
          );
          url.searchParams.set('state', state);
          if (labels?.trim()) url.searchParams.set('labels', labels.trim());
          url.searchParams.set('per_page', String(Math.min(Math.max(1, Math.floor(limit)), 30)));
          const response = await fetchImpl(url, {
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'personal-ai-assistant', ...authHeaders },
          });
          if (!response.ok) {
            return { ok: false, error: `GitHub API 返回 ${response.status}` };
          }
          const issues = (await response.json()) as GitHubIssueItem[];
          return {
            ok: true,
            data: {
              count: issues.length,
              issues: issues.map((issue) => ({
                number: issue.number ?? 0,
                title: issue.title ?? '',
                state: issue.state ?? '',
                labels: (issue.labels ?? []).map((label) => label.name ?? '').filter(Boolean),
                author: issue.user?.login ?? '',
                createdAt: issue.created_at ?? '',
                url: issue.html_url ?? '',
              })),
            },
          };
        } catch (error) {
          return {
            ok: false,
            error: `查询 issue 失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
    {
      name: 'github.create_issue',
      description:
        '在 GitHub 仓库创建 issue（L1，会真实写入 GitHub，需要 GITHUB_TOKEN）。' +
        '用于 bot 自主汇报缺陷/需求或跟踪开发任务。',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: '仓库，如 OpenPromise/promise-ai' },
          title: { type: 'string', description: 'issue 标题' },
          body: { type: 'string', description: 'issue 正文（可选）' },
          labels: { type: 'array', items: { type: 'string' }, description: 'label 列表（可选）' },
        },
        required: ['repo', 'title'],
      },
      permissionLevel: 1,
      timeoutMs: 20_000,
      async execute(input: unknown) {
        const { repo, title, body, labels } = (input ?? {}) as {
          repo?: string;
          title?: string;
          body?: string;
          labels?: string[];
        };
        const parsed = repo ? parseRepo(repo) : null;
        if (!parsed) return { ok: false, error: 'repo 格式应为 owner/name' };
        if (!title?.trim()) return { ok: false, error: '缺少 title 参数' };
        if (!token) {
          return { ok: false, error: '未配置 GITHUB_TOKEN，无法创建 issue' };
        }
        try {
          const response = await fetchImpl(
            `https://api.github.com/repos/${parsed.owner}/${parsed.name}/issues`,
            {
              method: 'POST',
              headers: {
                accept: 'application/vnd.github+json',
                'content-type': 'application/json',
                'user-agent': 'personal-ai-assistant',
                ...authHeaders,
              },
              body: JSON.stringify({
                title: title.trim(),
                ...(body?.trim() ? { body: body.trim() } : {}),
                ...(Array.isArray(labels) && labels.length > 0 ? { labels } : {}),
              }),
            },
          );
          if (!response.ok) {
            const raw = await response.text();
            return { ok: false, error: `GitHub API 返回 ${response.status}：${raw.slice(0, 200)}` };
          }
          const issue = (await response.json()) as GitHubIssueItem & { html_url?: string };
          return {
            ok: true,
            data: {
              number: issue.number ?? 0,
              title: issue.title ?? title.trim(),
              url: issue.html_url ?? '',
              note: `已创建 issue #${issue.number ?? ''}`,
            },
          };
        } catch (error) {
          return {
            ok: false,
            error: `创建 issue 失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
    {
      name: 'github.comment',
      description:
        '在 GitHub issue/PR 下发表评论（L1，会真实写入 GitHub，需要 GITHUB_TOKEN）。',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: '仓库，如 OpenPromise/promise-ai' },
          issueNumber: { type: 'number', description: 'issue/PR 编号' },
          body: { type: 'string', description: '评论内容' },
        },
        required: ['repo', 'issueNumber', 'body'],
      },
      permissionLevel: 1,
      timeoutMs: 20_000,
      async execute(input: unknown) {
        const { repo, issueNumber, body } = (input ?? {}) as {
          repo?: string;
          issueNumber?: number;
          body?: string;
        };
        const parsed = repo ? parseRepo(repo) : null;
        if (!parsed) return { ok: false, error: 'repo 格式应为 owner/name' };
        if (!Number.isInteger(issueNumber) || !body?.trim()) {
          return { ok: false, error: '缺少 issueNumber 或 body 参数' };
        }
        if (!token) {
          return { ok: false, error: '未配置 GITHUB_TOKEN，无法发表评论' };
        }
        try {
          const response = await fetchImpl(
            `https://api.github.com/repos/${parsed.owner}/${parsed.name}/issues/${issueNumber}/comments`,
            {
              method: 'POST',
              headers: {
                accept: 'application/vnd.github+json',
                'content-type': 'application/json',
                'user-agent': 'personal-ai-assistant',
                ...authHeaders,
              },
              body: JSON.stringify({ body: body.trim() }),
            },
          );
          if (!response.ok) {
            const raw = await response.text();
            return { ok: false, error: `GitHub API 返回 ${response.status}：${raw.slice(0, 200)}` };
          }
          const comment = (await response.json()) as { html_url?: string };
          return {
            ok: true,
            data: { issueNumber, url: comment.html_url ?? '', note: '评论已发布' },
          };
        } catch (error) {
          return {
            ok: false,
            error: `发表评论失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
  ];
}
