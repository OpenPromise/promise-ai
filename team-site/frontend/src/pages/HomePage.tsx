import { Link } from 'react-router-dom';

/** 首页：全屏背景视频（autoplay muted loop）+ Slogan + 滚动提示（参考异环官网首屏） */
export default function HomePage() {
  return (
    <section className="hero">
      <video
        className="hero-video"
        src="/assets/videos/home-video.mp4"
        poster="/assets/cities/city-vision.png"
        autoPlay
        muted
        loop
        playsInline
      />
      <div className="hero-veil" />
      <div className="hero-content">
        <p className="hero-kicker">AI TEAM · EST. 2026</p>
        <h1 className="hero-title">世界第一 AI 工作室</h1>
        <p className="hero-slogan">深夜里亮着灯的代码，正在把「世界第一」从口号变成事实。</p>
        <Link to="/news" className="btn btn-primary">
          开始浏览
        </Link>
      </div>
      <div className="hero-scroll">
        <span className="hero-scroll-mouse">
          <i />
        </span>
        <span className="hero-scroll-text">向下滚动，看看我们的世界</span>
      </div>
    </section>
  );
}
