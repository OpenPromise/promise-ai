import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import NavBar from './components/NavBar';
import Footer from './components/Footer';
import LoadingOverlay from './components/LoadingOverlay';
import HomePage from './pages/HomePage';
import NewsPage from './pages/NewsPage';
import RolesPage from './pages/RolesPage';
import WorldPage from './pages/WorldPage';
import CityPage from './pages/CityPage';

/** 路由切换时回到顶部 */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export default function App() {
  const location = useLocation();

  return (
    <>
      <LoadingOverlay />
      <ScrollToTop />
      <NavBar />
      {/* key=pathname：路由切换时重放入场动画（style-guide §6 全屏区块过渡 600ms） */}
      <main className="app-main" key={location.pathname}>
        <Routes location={location}>
          <Route path="/" element={<HomePage />} />
          <Route path="/news" element={<NewsPage />} />
          <Route path="/roles" element={<RolesPage />} />
          <Route path="/world" element={<WorldPage />} />
          <Route path="/city" element={<CityPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Footer />
    </>
  );
}
