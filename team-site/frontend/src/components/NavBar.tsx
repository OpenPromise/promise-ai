import { SECTIONS } from '../lib/sections';

/**
 * 顶栏：对齐参考站——logo 左、导航居中；hover/当前板块青色提亮发光。
 * 板块切换 = 点击 scrollIntoView（参考站 headerNav 按钮 slideTo 的等价实现）。
 */
export default function NavBar({
  active,
  onNavigate,
}: {
  active: string;
  onNavigate: (id: string) => void;
}) {
  return (
    <header className="nav">
      <a
        className="nav-logo"
        href="#home"
        onClick={(e) => {
          e.preventDefault();
          onNavigate('home');
        }}
      >
        <span className="nav-logo-mark">AI°</span>
        <span className="nav-logo-text">世界第一 AI 工作室</span>
      </a>
      <nav className="nav-links" aria-label="主导航">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`nav-link${active === s.id ? ' is-active' : ''}`}
            aria-current={active === s.id ? 'page' : undefined}
            onClick={() => onNavigate(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
