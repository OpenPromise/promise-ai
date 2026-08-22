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

/** 单 Tab 最多展示条数（参考站每频道 5 条；保证全屏内放得下） */
const MAX_PER_TAB = 5;

/**
 * 情报速递：对齐参考站 pageNews——左右装饰细线 + Tab + 斜切徽章行列表
 * （徽章/标题/日期，标题 hover 提亮，行底 #313131 分割线）。
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
        <SectionHead kicker="NEWS" title="情报速递" desc="做了什么、谁入职了、谁发牢骚了——团队动态，随时同步。" />
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
              {t.label}
            </button>
          ))}
        </div>
        <div className="news-list">
          {items === null ? (
            <p className="loading-text">加载中…</p>
          ) : (
            list.map((n) => (
              <article key={n.id} className={`news-item-row${n.pinned ? ' is-pinned' : ''}`}>
                <TypeBadge type={n.type} />
                <div className="news-title-col">
                  <h3 className="news-title">{n.title}</h3>
                  {n.content && <p className="news-summary">{n.content}</p>}
                </div>
                {n.pinned && <span className="news-pin">置顶</span>}
                <time className="news-date">{n.date.slice(5).replace('-', '/')}</time>
              </article>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
