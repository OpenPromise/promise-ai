import { useEffect, useState } from 'react';
import { fetchNews, fetchRoles, fetchWorlds } from '../api/client';
import type { NewsItem, Role, World } from '../api/client';

const POSTER = '/assets/cities/city-vision.png';
const VIDEO = '/assets/videos/home-video.mp4';

export default function HomePage({ onNavigate }: { onNavigate: (id: string) => void }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [worlds, setWorlds] = useState<World[]>([]);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    Promise.all([fetchRoles(), fetchNews('all'), fetchWorlds()]).then(([r, n, w]) => {
      setRoles(r);
      setNews(n);
      setWorlds(w);
    });
  }, []);

  const evidence = [
    { code: '01', title: '任务被接住', text: '小夜把需求、上下文与下一步串成可执行的工作。' },
    { code: '02', title: '工具产生结果', text: 'Agent 不只回答问题，也会调用工具、修改文件、完成动作。' },
    { code: '03', title: '记忆让工作继续', text: '会话、长期记忆和调度让一次对话不止停在当下。' },
  ];

  return (
    <section id="home" className="page-sec taskroom-home">
      <div className="home-hero">
        <div className="hero-copy">
          <p className="eyebrow">PROMISE AI <span>/</span> TASKROOM</p>
          <h1>让任务被接住，<em>继续向前。</em></h1>
          <p className="hero-lede">一个由 AI Agent、工具执行、记忆与调度组成的工作室。这里展示的不是角色海报，而是工作如何发生。</p>
          <div className="hero-actions">
            <button className="button button-primary" onClick={() => onNavigate('system')}>看它如何工作 <span>↗</span></button>
            <button className="text-link" onClick={() => onNavigate('signals')}>查看最新情报 <span>→</span></button>
          </div>
          <div className="hero-route">
            <span><b>01</b> 任务现场</span><span><b>02</b> Agent 网络</span><span><b>03</b> 工作证据</span>
          </div>
        </div>
        <div className={`hero-media${videoFailed ? ' is-poster' : ''}`} style={videoFailed ? { backgroundImage: `url(${POSTER})` } : undefined}>
          {!videoFailed && <video src={VIDEO} poster={POSTER} autoPlay muted loop playsInline onError={() => setVideoFailed(true)} aria-label="Promise AI 工作室现场片段" />}
          <div className="media-overlay" />
          <div className="media-meta"><span>LIVE SCENE / 00{news.length || 1}</span><span>VIDEO MUTED</span></div>
          <span className="media-caption">现场片段 · 不承担事实证明</span>
        </div>
      </div>

      <div className="section-shell evidence-shell">
        <div className="section-label"><span>01</span><span>WHY TASKROOM</span></div>
        <div className="evidence-grid">
          {evidence.map((item) => <article className="evidence-card" key={item.code}><span className="card-code">{item.code}</span><h2>{item.title}</h2><p>{item.text}</p></article>)}
        </div>
      </div>

      <div className="section-shell role-network-shell">
        <div className="section-label"><span>02</span><span>AGENT NETWORK</span></div>
        <div className="split-heading"><h2>角色不是海报，<br /><em>是工作节点。</em></h2><p>小夜负责接住和路由，小黑、小优、小美分别把任务推进到工程、运维和设计现场。</p></div>
        <div className="role-network">
          {roles.map((role, index) => <button className={`role-node${index === 0 ? ' is-core' : ''}`} key={role.id} onClick={() => onNavigate('team')}><span className="node-line" /><img src={role.avatarUrl} alt="" /><span className="node-copy"><b>{role.name}</b><small>{role.title}</small></span><span className="node-arrow">↗</span></button>)}
        </div>
      </div>

      <div className="section-shell home-signals-shell">
        <div className="section-label"><span>03</span><span>PROOF / SIGNALS</span><button onClick={() => onNavigate('signals')}>全部情报 →</button></div>
        <div className="signal-feature-grid">
          <div className="signal-intro"><p className="eyebrow">WORKING RECORDS</p><h2>真实工作，<br /><em>留下可读的痕迹。</em></h2><p>情报不是指标墙，而是团队已经确认、已经发生、可以继续追踪的记录。</p></div>
          <div className="signal-list">{news.slice(0, 3).map((item) => <article key={item.id}><span className={`signal-type type-${item.type}`}>{item.type === 'work' ? 'WORK' : item.type === 'join' ? 'JOIN' : 'NOTE'}</span><div><h3>{item.title}</h3><p>{item.author} · {item.date}</p></div><span>↗</span></article>)}</div>
        </div>
      </div>

      <div className="section-shell workspace-shell">
        <div className="section-label"><span>04</span><span>WORKSPACES</span><button onClick={() => onNavigate('world')}>进入世界 →</button></div>
        <div className="workspace-grid">{worlds.map((world) => <button key={world.id} className="workspace-card" onClick={() => onNavigate('world')}><img src={world.imageUrl} alt={world.name} /><span className="workspace-shade" /><span className="workspace-text"><small>{world.owner} / WORKSPACE</small><b>{world.name}</b></span></button>)}</div>
      </div>
    </section>
  );
}
