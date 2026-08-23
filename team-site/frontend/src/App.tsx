import { useEffect, useRef, useState } from 'react';
import NavBar from './components/NavBar';
import Footer from './components/Footer';
import LoadingOverlay from './components/LoadingOverlay';
import HomePage from './pages/HomePage';
import NewsPage from './pages/NewsPage';
import RolesPage from './pages/RolesPage';
import SystemPage from './pages/SystemPage';
import WorldPage from './pages/WorldPage';
import NextPage from './pages/NextPage';
import { SECTIONS, canonicalSection, resolveInitialSection, scrollToSection, syncHash } from './lib/sections';

export default function App() {
  const scrollRef = useRef<HTMLElement>(null);
  const [active, setActive] = useState(resolveInitialSection());

  useEffect(() => {
    const target = resolveInitialSection();
    requestAnimationFrame(() => scrollToSection(target, 'auto'));
    syncHash(target);
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) {
          const id = canonicalSection(visible.target.id);
          setActive(id);
          syncHash(id);
        }
      },
      { root: container, threshold: [0.2, 0.5, 0.8] },
    );
    SECTIONS.forEach((section) => {
      const element = document.getElementById(section.id);
      if (element) io.observe(element);
    });
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const onHash = () => {
      const id = resolveInitialSection();
      if (id !== active) scrollToSection(id);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [active]);

  const go = (id: string) => {
    const target = canonicalSection(id);
    setActive(target);
    scrollToSection(target);
  };

  return (
    <>
      <LoadingOverlay />
      <NavBar active={active} onNavigate={go} />
      <main className="site-scroll" ref={scrollRef}>
        <HomePage onNavigate={go} />
        <NewsPage />
        <RolesPage />
        <SystemPage onNavigate={go} />
        <WorldPage />
        <NextPage onNavigate={go} />
      </main>
      <Footer onHome={() => go('home')} />
    </>
  );
}
