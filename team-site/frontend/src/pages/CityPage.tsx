import { useEffect, useState } from 'react';
import { fetchCities } from '../api/client';
import type { City } from '../api/client';

/**
 * 都市映像：对齐参考站 pageCity——全屏愿景大图 + 渐变压暗遮罩 + 居中标题文案
 * + 底部装饰线与分页点（参考站 .cityPagination 基因：active 青色 + 描边）。
 */
export default function CityPage() {
  const [cities, setCities] = useState<City[] | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchCities().then((list) => {
      if (alive) {
        setCities(list);
        setActive((a) => (a >= list.length ? 0 : a));
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const city = cities?.[active];
  const count = cities?.length ?? 0;

  return (
    <section id="city" className="page-sec city-page">
      {cities === null ? (
        <p className="loading-text">加载中…</p>
      ) : (
        city && (
          <div className="city-stage" key={city.id}>
            <img className="city-img" src={city.imageUrl} alt={city.title} />
            <div className="city-veil" />
            <div className="section-lines" aria-hidden="true" />
            <div className="city-content">
              <span className="section-kicker">CITY OF DREAM</span>
              <h2 className="city-title">{city.title}</h2>
              <p className="city-desc">{city.description}</p>
            </div>
            {count > 1 && (
              <div className="city-dots" role="tablist" aria-label="都市映像切换">
                {cities.map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`city-dot${i === active ? ' is-active' : ''}`}
                    aria-label={c.title}
                    onClick={() => setActive(i)}
                  />
                ))}
              </div>
            )}
          </div>
        )
      )}
    </section>
  );
}
