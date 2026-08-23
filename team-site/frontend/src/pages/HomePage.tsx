/**
 * 首页：全屏背景视频（autoplay muted loop + poster）+ 底部黑色渐变，纯净视频区，
 * 无标题/副标语/CTA 按钮/滚动提示（已按批准方案净化）。
 */
export default function HomePage() {
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
    </section>
  );
}
