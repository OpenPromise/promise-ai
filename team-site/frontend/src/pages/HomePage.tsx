import { useEffect, useState } from 'react';
import { fetchCities, fetchNews, fetchRoles, fetchWorlds } from '../api/client';
import type { City, NewsItem, Role, World } from '../api/client';
import { HOME_CONTENT } from '../lib/homeContent';
import EditorialPeopleList from '../components/home/EditorialPeopleList';
import SignalPreview from '../components/home/SignalPreview';
import WorldPreview from '../components/home/WorldPreview';
import MissionPreview from '../components/home/MissionPreview';
import '../styles/home.css';

/** 跟随系统减动效偏好：true 时不自动播放视频，改为 poster 静态背景 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * 首页（Studio Editorial / 方向 A，DESIGN_SPEC §6.3）：
 * - 首屏：全屏视频/poster 舞台 + 品牌 H1 + 工作方式说明 + 主 CTA「认识团队」+ 次级「查看最新动态」；
 * - 下方编辑式内容流：团队目录 → 最新情报 → 工作场景 → 未来都市愿景收束；
 * - 视频为装饰媒体（aria-hidden），关键品牌信息是真实 DOM 文本；
 *   视频不可播放 / 减动效时回退 poster 背景，DOM 文案与 CTA 完整可用；
 * - 数据全部来自现有 API（失败时前端静态兜底），不新增任何项目无证据的事实。
 */
export default function HomePage({ onNavigate }: { onNavigate: (id: string) => void }) {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [news, setNews] = useState<NewsItem[] | null>(null);
  const [worlds, setWorlds] = useState<World[] | null>(null);
  const [cities, setCities] = useState<City[] | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  const reduceMotion = usePrefersReducedMotion();

  useEffect(() => {
    let alive = true;
    fetchRoles().then((list) => alive && setRoles(list));
    fetchNews('all').then((list) => alive && setNews(list));
    fetchWorlds().then((list) => alive && setWorlds(list));
    fetchCities().then((list) => alive && setCities(list));
    return () => {
      alive = false;
    };
  }, []);

  const showPoster = reduceMotion || videoFailed;
  const city = cities?.[0] ?? null;

  return (
    <section id="home" className="page-sec home-page">
      {/* 首屏舞台：视频（装饰）/ poster 降级 + 品牌文案 + 主 CTA */}
      <div className="home-hero">
        <div
          className={`home-hero-stage${showPoster ? ' is-poster' : ''}`}
          style={showPoster ? { backgroundImage: `url(${HOME_CONTENT.posterUrl})` } : undefined}
        >
          {!showPoster && (
            <video
              className="hero-video"
              src={HOME_CONTENT.videoUrl}
              poster={HOME_CONTENT.posterUrl}
              autoPlay
              muted
              loop
              playsInline
              aria-hidden="true"
              onError={() => setVideoFailed(true)}
            />
          )}
          <div className="hero-veil" aria-hidden="true" />
        </div>

        <div className="home-hero-copy">
          <p className="home-kicker">{HOME_CONTENT.heroKicker}</p>
          <h1 className="home-headline">{HOME_CONTENT.headline}</h1>
          <p className="home-sub">{HOME_CONTENT.heroSub}</p>
          <div className="home-actions">
            <a
              className="home-cta"
              href="#roles"
              onClick={(e) => {
                e.preventDefault();
                onNavigate(HOME_CONTENT.primaryCtaTarget);
              }}
            >
              {HOME_CONTENT.primaryCta}
            </a>
            <a
              className="home-secondary"
              href="#news"
              onClick={(e) => {
                e.preventDefault();
                onNavigate(HOME_CONTENT.secondaryLinkTarget);
              }}
            >
              {HOME_CONTENT.secondaryLink}
              <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>

        <p className="home-index" aria-hidden="true">
          {HOME_CONTENT.heroIndex}
        </p>
      </div>

      {/* 编辑式内容流：身份 → 组成 → 工作证据 → 工作场景 → 愿景收束 */}
      <EditorialPeopleList roles={roles} onNavigate={onNavigate} />
      <SignalPreview news={news} onNavigate={onNavigate} />
      <WorldPreview worlds={worlds} onNavigate={onNavigate} />
      <MissionPreview city={city} onNavigate={onNavigate} />
    </section>
  );
}
