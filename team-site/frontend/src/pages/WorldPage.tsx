import { useEffect, useState } from 'react';
import { fetchCities, fetchWorlds } from '../api/client';
import type { City, World } from '../api/client';

export default function WorldPage() {
  const [worlds, setWorlds] = useState<World[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  useEffect(() => { Promise.all([fetchWorlds(), fetchCities()]).then(([w, c]) => { setWorlds(w); setCities(c); }); }, []);
  return <section id="world" className="page-sec content-page world-page-new">
    <div className="page-intro"><p className="eyebrow">05 / WORLD</p><h1>每个 Agent，<br /><em>都有自己的现场。</em></h1><p>这里的世界不是装饰背景。它是角色面对的工作上下文；城市是还没有抵达的方向。</p></div>
    <div className="world-grid-new">{worlds.map((world) => <article key={world.id}><img src={world.imageUrl} alt={world.name} /><div><p className="eyebrow">{world.owner} / WORKSPACE</p><h2>{world.name}</h2><p>{world.description}</p></div></article>)}</div>
    {cities[0] && <article className="vision-banner"><img src={cities[0].imageUrl} alt={cities[0].title} /><div><p className="eyebrow">VISION / NOT NOW</p><h2>{cities[0].title}</h2><p>{cities[0].description}</p></div></article>}
  </section>;
}
