import { useEffect, useState } from 'react';
import { fetchNews } from '../api/client';
import type { NewsItem, NewsType } from '../api/client';
import SectionHead from '../components/SectionHead';
import TypeBadge from '../components/TypeBadge';

const TABS: { key: NewsType; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'work', label: '做了什么' },
  { key: 'join', label: '谁入职了' },
  { key: 'complaint', label: '谁发牢骚了' },
];

/** 单 Tab 最多展示条数（参考站每频道 5 条） */
const MAX_PER_TAB = 5;

/**
 * 情报速递：1:1 对齐参考站 pageNews（逆向见 docs/navbar-news-1to1.md §4）——
 * 装饰细线 + 标题区 + 方形斜切 Tab + 行列表（斜切徽章 / 标题 hover 变青 / 日期 MM/DD 右对齐 / 行底 #313131）。
 * 行结构与参考站一致：徽章 + 标题 + 日期（无摘要/封面/跳转链接，团队动态无外部详情页）。
 * 数据仍从 /api/news 拉取（type 过滤），API 不可用时走客户端兜底数据。
 */
export default function NewsPage() {
  const [tab, setTab] = useState<NewsType>('all');
  const [items, setItems] = useState<NewsItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    setItems(null);
    fetchNews(tab).then((list) => {
      if (alive) setItems(list);
    });
    return () => {
      alive = false;
    };
  }, [tab]);

  const list = items?.slice(0, MAX_PER_TAB) ?? [];

  return (
    <section id="news" className="page-sec news-page">
      <div className="news-inner">
        <div className="section-lines" aria-hidden="true" />
        <SectionHead kicker="NEWS" title="情报速递" />
        <div className="tabs" role="tablist" aria-label="情报类型">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`tab${tab === t.key ? ' is-active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <div className="news-list">
          {items === null ? (
            <p className="loading-text">加载中…</p>
          ) : (
            list.map((n) => (
              <article key={n.id} className="news-item-row">
                <TypeBadge type={n.type} />
                <h3 className="news-title">{n.title}</h3>
                <time className="news-date">{n.date.slice(5).replace('-', '/')}</time>
              </article>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
