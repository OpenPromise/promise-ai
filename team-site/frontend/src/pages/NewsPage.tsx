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

/** 情报速递：类型 Tab + 动态时间线（数据来自 /api/news，失败回退静态兜底） */
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

  return (
    <section className="page news-page">
      <div className="page-inner">
        <SectionHead
          kicker="NEWS"
          title="情报速递"
          desc="做了什么、谁入职了、谁发牢骚了——团队动态，随时同步。"
        />
        <div className="tabs" role="tablist" aria-label="情报类型">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`tab${tab === t.key ? ' is-active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="news-list">
          {items === null ? (
            <p className="loading-text">加载中…</p>
          ) : (
            items.map((n) => (
              <article key={n.id} className={`news-card${n.pinned ? ' is-pinned' : ''}`}>
                <div className="news-meta">
                  <TypeBadge type={n.type} />
                  <time className="news-date">{n.date}</time>
                  {n.pinned && <span className="news-pin">置顶</span>}
                </div>
                <h3 className="news-title">{n.title}</h3>
                {n.content && <p className="news-content">{n.content}</p>}
                <span className="news-author">—— {n.author}</span>
              </article>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
