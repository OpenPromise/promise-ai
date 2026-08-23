import { useEffect, useState } from 'react';
import { fetchNews } from '../api/client';
import type { NewsItem, NewsType } from '../api/client';
import SectionHead from '../components/SectionHead';
import TypeBadge from '../components/TypeBadge';
import { NEWS_CAROUSEL_SLIDES } from '../lib/newsCarousel';

const TABS: { key: NewsType; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'work', label: '做了什么' },
  { key: 'join', label: '谁入职了' },
  { key: 'complaint', label: '谁发牢骚了' },
];

/** 单 Tab 最多展示条数（参考站每频道固定 5 条；列表容器高度固定为 5 行，不随内容伸缩） */
const MAX_PER_TAB = 5;

/**
 * 情报速递：1:1 对齐参考站 pageNews（逆向见 docs/navbar-news-1to1.md §4）——
 * 左右双列：左 = 公告列表（标题区 + 方形斜切 Tab + 固定 5 行列表），右 = 宣传图轮播（边框 + 标题条 + 分页点）。
 * 左列列表容器高度固定（5 × 行高），数据不足 5 条时保持高度、不伸缩（CEO 反馈 3）。
 * 右列图片为团队生活照（集中管理 URL，见 lib/newsCarousel.ts，可替换为真实照片）。
 */
export default function NewsPage() {
  const [tab, setTab] = useState<NewsType>('all');
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [slide, setSlide] = useState(0);

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
  const slides = NEWS_CAROUSEL_SLIDES;

  // 轮播自动切换（参考站 newsSwiper autoplay）
  useEffect(() => {
    const t = setInterval(() => {
      setSlide((s) => (s + 1) % slides.length);
    }, 4000);
    return () => clearInterval(t);
  }, [slides.length]);

  return (
    <section id="news" className="page-sec news-page">
      <div className="news-inner">
        <div className="section-lines" aria-hidden="true" />
        <SectionHead kicker="NEWS" title="情报速递" />
        <div className="news-cols">
          {/* 左列：公告列表（标题区 + Tab + 固定 5 行列表） */}
          <div className="news-col">
            <div className="news-col-head">
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
              <div className="news-col-title" aria-hidden="true">
                <span>更多</span>
              </div>
            </div>
            <div className="news-list">
              {items === null ? (
                <p className="loading-text">加载中…</p>
              ) : (
                <>
                  {list.map((n) => (
                    <article key={n.id} className="news-item-row">
                      <TypeBadge type={n.type} />
                      <h3 className="news-title">{n.title}</h3>
                      <time className="news-date">{n.date.slice(5).replace('-', '/')}</time>
                    </article>
                  ))}
                  {/* 固定 5 行：数据不足时补空行占位，保持列表高度恒定（CEO 反馈 3） */}
                  {Array.from({ length: Math.max(0, MAX_PER_TAB - list.length) }).map((_, i) => (
                    <article key={`placeholder-${i}`} className="news-item-row is-placeholder" aria-hidden="true" />
                  ))}
                </>
              )}
            </div>
          </div>
          {/* 右列：宣传图轮播（926×468 边框 + 标题条 + 分页点） */}
          <div className="news-swiper-col">
            <div className="news-swiper" role="region" aria-label="团队生活照轮播">
              <div className="news-swiper-stage">
                {slides.map((s, i) => (
                  <img
                    key={s.imageUrl}
                    src={s.imageUrl}
                    alt={s.title}
                    loading={i === 0 ? 'eager' : 'lazy'}
                    className={`news-swiper-img${i === slide ? ' is-active' : ''}`}
                  />
                ))}
              </div>
              <div className="news-swiper-tit" aria-live="polite">
                {slides[slide]?.title}
              </div>
              <div className="news-swiper-dots" role="tablist" aria-label="轮播分页">
                {slides.map((s, i) => (
                  <button
                    key={s.imageUrl}
                    type="button"
                    role="tab"
                    aria-selected={i === slide}
                    aria-label={s.title}
                    className={`news-swiper-dot${i === slide ? ' is-active' : ''}`}
                    onClick={() => setSlide(i)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
