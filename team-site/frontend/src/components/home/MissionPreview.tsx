import { HOME_CONTENT } from '../../lib/homeContent';
import type { City } from '../../api/client';

/**
 * 未来都市愿景收束（MissionPreview，DESIGN_SPEC §6.4 / §6.3 Section 5）：
 * 使用 city-vision.png 作为愿景收束，kicker 明确「愿景 / NEXT」语义，
 * 不得暗示这是当前办公地点；内容来自现有 City API 数据。
 * 状态：loading / 空 / 成功（API 失败时 client 回退静态兜底数据）。
 */
export default function MissionPreview({
  city,
  onNavigate,
}: {
  city: City | null;
  onNavigate: (id: string) => void;
}) {
  return (
    <div className="home-block home-mission">
      {city && (
        <div
          className="home-mission-bg"
          role="img"
          aria-label="未来都市愿景图"
          style={{ backgroundImage: `url(${city.imageUrl})` }}
        />
      )}
      <div className="home-mission-veil" aria-hidden="true" />
      <div className="home-mission-content">
        <p className="home-kicker">{HOME_CONTENT.mission.kicker}</p>
        {city === null ? (
          <p className="home-block-status">{HOME_CONTENT.mission.loading}</p>
        ) : (
          <>
            <span className="home-mission-note">{HOME_CONTENT.mission.note}</span>
            <h2 className="home-mission-title">{city.title}</h2>
            <p className="home-mission-desc">{city.description}</p>
            <a
              className="home-signal-link"
              href="#city"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('city');
              }}
            >
              {HOME_CONTENT.mission.cta}
              <span aria-hidden="true">→</span>
            </a>
          </>
        )}
      </div>
    </div>
  );
}
