import express from 'express';
import { news, roles, worlds, cities } from './data.js';

/**
 * news 的 type 过滤：规范值 all/work/join/complaint（契约：docs/content-model.md）。
 * 兼容中文别名（任务文案「做了什么/入职/牢骚」与契约英文码双轨），映射到规范值。
 */
const TYPE_ALIASES = Object.freeze({
  all: 'all',
  全部: 'all',
  work: 'work',
  做了什么: 'work',
  join: 'join',
  入职: 'join',
  谁入职了: 'join',
  complaint: 'complaint',
  牢骚: 'complaint',
  谁发牢骚了: 'complaint',
});
const VALID_TYPES = Object.freeze(['all', 'work', 'join', 'complaint']);

function normalizeType(raw) {
  if (raw === undefined || raw === null || raw === '') return 'all';
  const key = String(raw).trim();
  return TYPE_ALIASES[key] ?? null;
}

/** 按 date 倒序；同日置顶优先，其余保持录入顺序（稳定排序） */
function sortNews(items) {
  return [...items].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return 0;
  });
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/news', (req, res) => {
    const type = normalizeType(req.query.type);
    if (type === null) {
      return res
        .status(400)
        .json({ error: 'invalid type', allowed: VALID_TYPES, got: String(req.query.type) });
    }
    const items = type === 'all' ? news : news.filter((n) => n.type === type);
    res.json(sortNews(items));
  });

  app.get('/api/roles', (_req, res) => {
    res.json(roles);
  });

  app.get('/api/worlds', (_req, res) => {
    res.json(worlds);
  });

  app.get('/api/cities', (_req, res) => {
    res.json(cities);
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'team-site-api',
      version: '1.0.0',
      time: new Date().toISOString(),
    });
  });

  // 未匹配路由 → 404 JSON（前端 fetch 据此走兜底数据）
  app.use((req, res) => {
    res.status(404).json({ error: 'Not Found', path: req.path });
  });

  return app;
}
