import { useEffect, useRef, useState } from 'react';
import NavBar from './components/NavBar';
import Footer from './components/Footer';
import LoadingOverlay from './components/LoadingOverlay';
import HomePage from './pages/HomePage';
import NewsPage from './pages/NewsPage';
import RolesPage from './pages/RolesPage';
import WorldPage from './pages/WorldPage';
import CityPage from './pages/CityPage';
import { SECTIONS, resolveInitialSection, scrollToSection, syncHash } from './lib/sections';

/**
 * 官网骨架：单页 + 全屏 scroll-snap 翻页（对齐参考站 wrapSwiper 五板块）。
 * - main.site-scroll 为滚动容器（y mandatory 吸附），五板块整屏切换；
 * - IntersectionObserver 维护当前板块（顶栏高亮 + hash 深链 + 悬浮 footer 显隐）。
 */
export default function App() {
  const scrollRef = useRef<HTMLElement>(null);
  const [active, setActive] = useState<string>(resolveInitialSection());

  // 初始定位：进入地址映射到对应板块（覆盖在加载页之下，淡出后即到位）
  useEffect(() => {
    const target = resolveInitialSection();
    requestAnimationFrame(() => scrollToSection(target, 'auto'));
    syncHash(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 滚动监听：当前板块高亮 + hash 同步
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActive(entry.target.id);
            syncHash(entry.target.id);
          }
        }
      },
      { root: container, threshold: 0.5 },
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    });
    return () => io.disconnect();
  }, []);

  // 浏览器前进/后退（hash 变化）时跟随
  useEffect(() => {
    const onHash = () => {
      const id = resolveInitialSection();
      if (id !== active) scrollToSection(id);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [active]);

  const go = (id: string) => {
    setActive(id);
    scrollToSection(id);
  };

  return (
    <>
      <LoadingOverlay />
      <NavBar active={active} onNavigate={go} />
      <main className="site-scroll" ref={scrollRef}>
        <HomePage onNavigate={go} />
        <NewsPage />
        <RolesPage />
        <WorldPage />
        <CityPage />
      </main>
      <Footer visible={active === 'city'} onHome={() => go('home')} />
    </>
  );
}
