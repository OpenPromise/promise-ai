import { HOME_CONTENT } from '../../lib/homeContent';
import type { World } from '../../api/client';

/**
 * 工作场景（WorldPreview，DESIGN_SPEC §6.4）：
 * 三张 World 图静态横向索引（不重复构建第二套场景轮播），
 * 说明「成员如何工作、工作对象是什么」；点击进入 #world。
 * 状态：loading / 空 / 成功（API 失败时 client 回退静态兜底数据）。
 */
export default function WorldPreview({
  worlds,
  onNavigate,
}: {
  worlds: World[] | null;
  onNavigate: (id: string) => void;
}) {
  return (
    <div className="home-block home-worlds">
      <div className="home-grid">
        <div className="home-block-head">
          <p className="home-kicker">{HOME_CONTENT.worlds.kicker}</p>
          <h2 className="home-block-title">{HOME_CONTENT.worlds.title}</h2>
          <p className="home-block-desc">{HOME_CONTENT.worlds.desc}</p>
        </div>

        {worlds === null ? (
          <p className="home-block-status">{HOME_CONTENT.worlds.loading}</p>
        ) : worlds.length === 0 ? (
          <p className="home-block-status">{HOME_CONTENT.worlds.empty}</p>
        ) : (
          <ul className="home-worlds-list">
            {worlds.map((w) => (
              <li key={w.id}>
                <a
                  className="home-worlds-item"
                  href="#world"
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate('world');
                  }}
                  aria-label={`${w.owner}的工作场景：${w.name}`}
                >
                  <img
                    className="home-worlds-img"
                    src={w.imageUrl}
                    alt={`${w.owner}的工作场景：${w.name}`}
                    loading="lazy"
                  />
                  <span className="home-worlds-owner">{w.owner}</span>
                  <span className="home-worlds-name">{w.name}</span>
                  <span className="home-worlds-desc">{w.description}</span>
                  <span className="home-worlds-more">
                    {HOME_CONTENT.worlds.cta}
                    <span aria-hidden="true">→</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
