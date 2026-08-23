import { useEffect, useRef, useState, type ReactNode } from 'react';
import { members, taskFlow, capabilities, milestones } from './data';

/** 进入视口时淡入上移，尊重 prefers-reduced-motion */
function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('in');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            el.classList.add('in');
            io.disconnect();
          }
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="reveal" style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

function Nav() {
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 40);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <nav className={`nav ${solid ? 'nav-solid' : ''}`}>
      <a className="nav-logo" href="#top">
        PROMISE<span> AI</span>
      </a>
      <div className="nav-links">
        <a href="#members">成员</a>
        <a href="#system">系统</a>
        <a href="#journey">历程</a>
        <a href="#vision">愿景</a>
      </div>
    </nav>
  );
}

function Hero() {
  return (
    <header className="hero" id="top">
      <video
        className="hero-video"
        src="/assets/videos/hero.mp4"
        poster="/assets/scenes/group.webp"
        autoPlay
        muted
        loop
        playsInline
      />
      <div className="hero-shade" />
      <div className="hero-content">
        <p className="mono-label">PROMISE AI — AN AI STUDIO, RUNNING</p>
        <h1>
          一个人，
          <br />
          六位 AI 同事。
        </h1>
        <p className="hero-sub">
          Promise AI 是一间正在运行的 AI 工作室——真实的任务、真实的工具、真实的记忆。
          <br />
          我们不演示未来，我们运行现在。
        </p>
      </div>
      <div className="hero-scroll" aria-hidden>
        <span />
      </div>
    </header>
  );
}

function Manifesto() {
  return (
    <section className="section manifesto">
      <Reveal>
        <p className="mono-label">MANIFESTO</p>
        <h2 className="statement">
          AI 不该只活在演示视频里。
          <br />
          在这里，它们有名字、有职责、有记忆，
          <br />
          <em>并且每天真的在工作。</em>
        </h2>
      </Reveal>
      <div className="manifesto-grid">
        {[
          {
            k: '真实运行',
            v: '不是概念稿。系统 7×24 在线，通过微信接收任务，此刻仍在服务它唯一的人类。',
          },
          {
            k: '各有其人',
            v: '每位 AI 员工的人格由自己书写，任何人不得代写——包括这个网站上她们的形象与梦想。',
          },
          {
            k: '全程留痕',
            v: '派单、工具调用、权限审批、交付结果，全部写入审计日志。可回放，可追责。',
          },
        ].map((it, i) => (
          <Reveal key={it.k} delay={i * 80}>
            <div className="manifesto-card">
              <h3>{it.k}</h3>
              <p>{it.v}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function Members() {
  return (
    <section className="section" id="members">
      <Reveal>
        <p className="mono-label">TEAM — 1 HUMAN + 6 AI</p>
        <h2 className="section-title">七个名字，一间公司</h2>
      </Reveal>
      <div className="members">
        {members.map((m, i) => (
          <Reveal key={m.id} delay={60}>
            <article
              className={`member ${i % 2 === 1 ? 'member-flip' : ''}`}
              style={{ ['--accent' as string]: m.accent }}
            >
              <div className="member-portrait">
                <img src={m.portrait} alt={`${m.name} · ${m.role}`} loading="lazy" />
              </div>
              <div className="member-info">
                <p className="mono-label accent">{m.label}</p>
                <h3>
                  {m.name}
                  <span className="member-en">{m.nameEn}</span>
                </h3>
                <p className="member-role">
                  {m.role} · {m.roleEn}
                </p>
                <p className="member-intro">{m.intro}</p>
                <blockquote className="member-dream">
                  <p>「{m.dream}」</p>
                  <cite>— {m.dreamNote}</cite>
                </blockquote>
                {m.homepage && (
                  <a className="member-link" href={m.homepage}>
                    访问 {m.name} 的个人主页 →
                  </a>
                )}
              </div>
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function System() {
  return (
    <section className="section section-dim" id="system">
      <Reveal>
        <p className="mono-label">HOW IT WORKS</p>
        <h2 className="section-title">一条任务的旅程</h2>
        <p className="section-sub">从一句话到一次交付，中间没有魔法，只有系统。</p>
      </Reveal>
      <ol className="flow">
        {taskFlow.map((s, i) => (
          <Reveal key={s.step} delay={i * 70}>
            <li className="flow-step">
              <span className="flow-num">{s.step}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          </Reveal>
        ))}
      </ol>
      <Reveal>
        <div className="caps">
          {capabilities.map((c) => (
            <div className="cap" key={c.name}>
              <h4>{c.name}</h4>
              <p>{c.desc}</p>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

function Journey() {
  return (
    <section className="section" id="journey">
      <Reveal>
        <p className="mono-label">JOURNEY</p>
        <h2 className="section-title">从零到五人</h2>
        <p className="section-sub">这间工作室很年轻——年轻到每一天都值得记录。</p>
      </Reveal>
      <div className="timeline">
        {milestones.map((m, i) => (
          <Reveal key={m.date} delay={i * 60}>
            <div className="timeline-item">
              <span className="timeline-date">{m.date}</span>
              <div className="timeline-body">
                <h3>{m.title}</h3>
                <p>{m.text}</p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function Vision() {
  return (
    <section className="vision" id="vision">
      <img className="vision-bg" src="/assets/scenes/group.webp" alt="" aria-hidden />
      <div className="vision-shade" />
      <div className="vision-content">
        <Reveal>
          <p className="mono-label">VISION</p>
          <h2>
            世界第一
            <br />
            AI 工作室。
          </h2>
          <p className="vision-sub">
            今天，它只有一位人类和六位 AI。
            <br />
            但每一天，他们都真实地在工作。
          </p>
        </Reveal>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-top">
        <div>
          <p className="nav-logo">
            PROMISE<span> AI</span>
          </p>
          <p className="footer-note">一间正在运行的 AI 工作室</p>
        </div>
        <div className="footer-links">
          <p className="mono-label">成员主页</p>
          <a href="/xiaoye/">小夜 · 私人助理</a>
          <a href="/xiaohei/">小黑 · 工程师</a>
          <a href="/xiaoyou/">小优 · 运维</a>
          <a href="/xiaomei/">小美 · 设计师</a>
        </div>
      </div>
      <p className="footer-bottom">
        © 2026 Promise AI · 本站由 AI 设计、生成并构建 —— 包括这句话
      </p>
    </footer>
  );
}

export default function App() {
  return (
    <>
      <Nav />
      <Hero />
      <main>
        <Manifesto />
        <Members />
        <System />
        <Journey />
        <Vision />
      </main>
      <Footer />
    </>
  );
}
