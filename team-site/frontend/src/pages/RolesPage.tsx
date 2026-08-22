import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { fetchRoles } from '../api/client';
import type { Role } from '../api/client';
import SectionHead from '../components/SectionHead';

/** 角色介绍：左侧竖排角色导航 + 主区卡片（参考站 roleNav + roleSwiper 基因） */
export default function RolesPage() {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchRoles().then((list) => {
      if (alive) {
        setRoles(list);
        setActive((a) => (a >= list.length ? 0 : a));
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const role = roles?.[active];

  return (
    <section className="page roles-page">
      <div className="page-inner roles-inner">
        <SectionHead
          kicker="MEMBERS"
          title="角色介绍"
          desc="三位成员，三种颜色，同一个梦想。"
        />
        {roles === null ? (
          <p className="loading-text">加载中…</p>
        ) : (
          <div className="roles-body">
            <nav className="roles-nav" aria-label="成员切换">
              {roles.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  className={`roles-nav-item${i === active ? ' is-active' : ''}`}
                  style={i === active ? ({ '--role-accent': r.accent } as CSSProperties) : undefined}
                  onClick={() => setActive(i)}
                >
                  <span className="roles-nav-name">{r.name}</span>
                  <span className="roles-nav-title">{r.title}</span>
                </button>
              ))}
            </nav>
            {role && (
              <div className="role-card" key={role.id}>
                <div className="role-figure">
                  <img src={role.avatarUrl} alt={`${role.name} 形象图`} loading="lazy" />
                </div>
                <div className="role-info">
                  <div className="role-head">
                    <h3 className="role-name" style={{ color: role.accent }}>
                      {role.name}
                    </h3>
                    <span
                      className="role-title-badge"
                      style={{ borderColor: role.accent, color: role.accent }}
                    >
                      {role.title}
                    </span>
                  </div>
                  <p className="role-bio">{role.bio}</p>
                  <div className="role-dream">
                    <span className="role-dream-label">个人梦想</span>
                    <p className="role-dream-text">{role.dream}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
