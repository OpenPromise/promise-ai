import { SECTIONS } from '../lib/sections';

export default function NavBar({
  active,
  onNavigate,
}: {
  active: string;
  onNavigate: (id: string) => void;
}) {
  return (
    <header className="nav">
      <a className="nav-logo" href="#home" onClick={(e) => { e.preventDefault(); onNavigate('home'); }}>
        <span className="nav-mark">P</span>
        <span className="nav-wordmark">PROMISE AI</span>
        <span className="nav-suffix">/ TASKROOM</span>
      </a>
      <nav className="nav-links" aria-label="主导航">
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className={`nav-link${active === section.id ? ' is-active' : ''}`}
            aria-current={active === section.id ? 'page' : undefined}
            onClick={() => onNavigate(section.id)}
          >
            <span className="nav-index">0{section.index}</span>
            {section.label}
          </button>
        ))}
      </nav>
      <span className="nav-status"><i /> SYSTEM / OBSERVABLE</span>
    </header>
  );
}
