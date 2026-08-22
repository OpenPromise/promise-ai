import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchCities } from '../api/client';
import type { City } from '../api/client';

/** 都市映像：全屏愿景大图 + 梦想愿景文案（参考站 pageCity 基因） */
export default function CityPage() {
  const [cities, setCities] = useState<City[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchCities().then((list) => {
      if (alive) setCities(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  const city = cities?.[0];

  return (
    <section className="city-page">
      {cities === null ? (
        <p className="loading-text">加载中…</p>
      ) : (
        city && (
          <div className="city-stage" key={city.id}>
            <img className="city-img" src={city.imageUrl} alt={city.title} />
            <div className="city-veil" />
            <div className="city-content">
              <span className="section-kicker">CITY OF DREAM</span>
              <h2 className="city-title">{city.title}</h2>
              <p className="city-desc">{city.description}</p>
              <Link to="/" className="btn btn-ghost">
                回到首页
              </Link>
            </div>
          </div>
        )
      )}
    </section>
  );
}
