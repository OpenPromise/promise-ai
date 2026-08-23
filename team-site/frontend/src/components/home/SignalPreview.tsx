import { HOME_CONTENT } from '../../lib/homeContent';
import TypeBadge from '../TypeBadge';
import type { NewsItem } from '../../api/client';

/**
 * 最新情报（SignalPreview，DESIGN_SPEC §6.4）：
 * 用一条最新 NewsItem 建立「正在做事」的证据，只显示类型/标题/日期/作者，
 * 不截断正文；点击进入 #news，不在首页嵌套完整 Tab 系统。
 * 状态：loading / 空 / 成功（API 失败时 client 回退静态兜底数据，界面不假装实时）。
 */
export default function SignalPreview({
  news,
  onNavigate,
}: {
  news: NewsItem[] | null;
  onNavigate: (id: string) => void;
}) {
  const featured = news?.[0] ?? null;

  return (
    <div className="home-block home-signal">
      <div className="home-grid">
        <div className="home-block-head home-signal-head">
          <p className="home-kicker">{HOME_CONTENT.signal.kicker}</p>
          <h2 className="home-block-title">{HOME_CONTENT.signal.title}</h2>
          <p className="home-block-desc">{HOME_CONTENT.signal.desc}</p>
        </div>

        {news === null ? (
          <p className="home-block-status">{HOME_CONTENT.signal.loading}</p>
        ) : featured ? (
          <article className="home-signal-card">
            <div className="home-signal-meta">
              <TypeBadge type={featured.type} />
              <time className="home-signal-date" dateTime={featured.date}>
                {featured.date}
              </time>
              <span className="home-signal-author">{featured.author}</span>
            </div>
            <h3 className="home-signal-title">{featured.title}</h3>
            <a
              className="home-signal-link"
              href="#news"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('news');
              }}
            >
              {HOME_CONTENT.signal.cta}
              <span aria-hidden="true">→</span>
            </a>
          </article>
        ) : (
          <div className="home-signal-card">
            <p className="home-block-status">{HOME_CONTENT.signal.empty}</p>
            <a
              className="home-signal-link"
              href="#roles"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('roles');
              }}
            >
              认识团队
              <span aria-hidden="true">→</span>
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
