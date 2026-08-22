import { useEffect, useState } from 'react';
import { fetchWorlds } from '../api/client';
import type { World } from '../api/client';
import SectionHead from '../components/SectionHead';

/**
 * 世界全景：对齐参考站 pageView——居中标题 + 装饰线 + 全屏场景大图
 * + 缩略导航（边框/active 青色描边/名称底条，参考站 .pageViewNav 基因）+ 左右箭头。
 */
export default function WorldPage() {
  const [worlds, setWorlds] = useState<World[] | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchWorlds().then((list) => {
      if (alive) {
        setWorlds(list);
        setActive((a) => (a >= list.length ? 0 : a));
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const world = worlds?.[active];
  const count = worlds?.length ?? 0;
  const prev = () => setActive((a) => (count ? (a + count - 1) % count : a));
  const next = () => setActive((a) => (count ? (a + 1) % count : a));

  return (
    <section id="world" className="page-sec world-page">
      {worlds === null ? (
        <p className="loading-text">加载中…</p>
      ) : (
        world && (
          <div className="world-stage" key={world.id}>
            <img className="world-img" src={world.imageUrl} alt={`${world.name} 全景图`} />
            <div className="world-veil" />
            <div className="section-lines" aria-hidden="true" />
            <SectionHead kicker="WORLD" title="世界全景" desc="成员们各自的小世界，和他们待得最久的地方。" />
            <div className="world-caption">
              <p className="world-owner">{world.owner} 的世界</p>
              <h2 className="world-name">{world.name}</h2>
              <p className="world-desc">{world.description}</p>
            </div>
            {count > 1 && (
              <>
                <button className="world-arrow world-prev" onClick={prev} aria-label="上一个场景">
                  ‹
                </button>
                <button className="world-arrow world-next" onClick={next} aria-label="下一个场景">
                  ›
                </button>
              </>
            )}
            <div className="world-thumbs">
              {worlds.map((w, i) => (
                <button
                  key={w.id}
                  type="button"
                  className={`world-thumb${i === active ? ' is-active' : ''}`}
                  onClick={() => setActive(i)}
                >
                  <img src={w.imageUrl} alt={w.name} />
                  <span className="world-thumb-name">{w.name}</span>
                </button>
              ))}
            </div>
          </div>
        )
      )}
    </section>
  );
}
