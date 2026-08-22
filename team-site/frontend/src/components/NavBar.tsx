import { NavLink } from 'react-router-dom';

const LINKS = [
  { to: '/', label: '首页' },
  { to: '/news', label: '情报速递' },
  { to: '/roles', label: '角色介绍' },
  { to: '/world', label: '世界全景' },
  { to: '/city', label: '都市映像' },
];

export default function NavBar() {
  return (
    <header className="nav">
      <NavLink to="/" className="nav-logo" end>
        <span className="nav-logo-mark">AI°</span>
        <span className="nav-logo-text">世界第一 AI 工作室</span>
      </NavLink>
      <nav className="nav-links" aria-label="主导航">
        {LINKS.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to === '/'}
            className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`}
          >
            {link.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
