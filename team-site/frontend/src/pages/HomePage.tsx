/**
 * 首页：对齐参考站 pageIndex——全屏背景视频（autoplay muted loop + poster）
 * + 底部黑色渐变 + Slogan + 滚动提示；CTA 按钮向下翻页到情报速递。
 */
export default function HomePage({ onExplore }: { onExplore: () => void }) {
  return (
    <section id="home" className="page-sec hero">
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
        <button type="button" className="btn btn-primary" onClick={onExplore}>
          开始浏览
        </button>
      </div>
      <div className="hero-scroll">
        <span className="hero-scroll-mouse">
          <i />
        </span>
        <span className="hero-scroll-text">滚动翻页，看看我们的世界</span>
      </div>
    </section>
  );
}
