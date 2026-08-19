import type { Tool } from './index.js';

interface WebSearchInput {
  query: string;
  language?: string;
  limit?: number;
}

interface WikiSearchResult {
  query?: {
    search?: Array<{
      title?: string;
      snippet?: string;
    }>;
  };
}

export function createWebSearchTool(fetchImpl: typeof fetch = fetch): Tool {
  return {
    name: 'web.search',
    description: '搜索互联网获取信息。默认搜索中文维基百科，返回相关条目标题与摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词',
        },
        language: {
          type: 'string',
          description: '维基百科语言代码，默认 zh',
        },
        limit: {
          type: 'number',
          description: '返回条数，默认 3，最大 5',
        },
      },
      required: ['query'],
    },
    permissionLevel: 0,
    async execute(input: unknown, context) {
      const { query, language = 'zh', limit = 3 } = (input ?? {}) as WebSearchInput;
      if (!query?.trim()) {
        return { ok: false, error: '缺少 query 参数' };
      }
      const capped = Math.min(Math.max(1, Math.floor(limit)), 5);

      try {
        const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
        url.searchParams.set('action', 'query');
        url.searchParams.set('list', 'search');
        url.searchParams.set('srsearch', query);
        url.searchParams.set('srlimit', String(capped));
        url.searchParams.set('format', 'json');
        url.searchParams.set('origin', '*');

        const response = await fetchImpl(url, { signal: context.signal });
        if (!response.ok) {
          return { ok: false, error: `搜索失败：HTTP ${response.status}` };
        }
        const json = (await response.json()) as WikiSearchResult;
        const results = (json.query?.search ?? []).map((item) => ({
          title: item.title ?? '',
          snippet: stripHtml(item.snippet ?? ''),
          url: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(item.title ?? '')}`,
        }));
        return {
          ok: true,
          data: { query, language, results },
        };
      } catch (error) {
        return {
          ok: false,
          error: `搜索失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}
