import { SECTIONS } from '../lib/sections';

/**
 * 顶栏（对齐参考站 .header）：一条完整的 fixed 顶栏 = 左 logo + 中导航按钮组 + 右品牌字标，
 * 三者同属 #1d1d1d 实底 bar（高 118 设计稿 = 4.6vw），视觉浑然一体。
 * 导航按钮：背景透明（参考站 sprite 仅文字像素，黑底即顶栏底色），紧贴无间距；
 * 三态 = 切图换色（sprite 像素实测）：normal 灰(170) → hover 白(255) → active 青(#51E5FB)。
 * 无任何 text-shadow/box-shadow 光晕（参考站 alpha 分布零扩散，纯切图）。
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
        {SECTIONS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={`nav-link${active === s.id ? ' is-active' : ''}${
              i === 0 ? ' is-first' : ''
            }`}
            aria-current={active === s.id ? 'page' : undefined}
            onClick={() => onNavigate(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      {/* 右品牌字标（参考站 .header 背景图 header.png 664×144 位置 100% 0；我们用文字装饰占位） */}
      <div className="nav-brand" aria-hidden="true">
        <span className="nav-brand-name">AI° STUDIO</span>
      </div>
    </header>
  );
}
