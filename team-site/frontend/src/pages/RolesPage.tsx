import { useEffect, useState } from 'react';
import { fetchRoles } from '../api/client';
import type { Role } from '../api/client';
import SectionHead from '../components/SectionHead';

/**
 * 角色介绍：对齐参考站 pageRole——
 * 左侧竖排角色缩略导航 + 整屏氛围背景（选中角色对应 world-* 图）+ 大图立绘 + 底部信息条。
 * 切换：缩略图点击 / 左右箭头；背景随选中角色切换（world 图，加载失败自动留暗底）。
 */
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
  const worldBg = role ? `/assets/worlds/${role.id}.png` : undefined;
  const count = roles?.length ?? 0;
  const prev = () => setActive((a) => (count ? (a + count - 1) % count : a));
  const next = () => setActive((a) => (count ? (a + 1) % count : a));

  return (
    <section id="roles" className="page-sec roles-page">
      <div className="roles-stage" style={worldBg ? { backgroundImage: `url(${worldBg})` } : undefined}>
        <div className="roles-veil" />
        <div className="section-lines" aria-hidden="true" />
        <SectionHead kicker="MEMBERS" title="角色介绍" desc="三位成员，三种颜色，同一个梦想。" />
        {roles === null ? (
          <p className="loading-text">加载中…</p>
        ) : (
          <>
            <nav className="roles-nav" aria-label="成员切换">
              {roles.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  className={`roles-nav-item${i === active ? ' is-active' : ''}`}
                  aria-label={`${r.name}：${r.title}`}
                  onClick={() => setActive(i)}
                >
                  <img src={r.avatarUrl} alt="" loading="lazy" />
                  <span>{r.name}</span>
                </button>
              ))}
            </nav>
            {role && (
              <div className="roles-main" key={role.id}>
                <button className="roles-arrow roles-prev" onClick={prev} aria-label="上一个角色">
                  ‹
                </button>
                <div className="role-figure">
                  <img src={role.avatarUrl} alt={`${role.name} 形象图`} loading="lazy" />
                </div>
                <button className="roles-arrow roles-next" onClick={next} aria-label="下一个角色">
                  ›
                </button>
                <div className="role-info-bar">
                  <div className="role-info-head">
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
                  <p className="role-dream">
                    <span className="role-dream-label">个人梦想</span>
                    <span className="role-dream-text">{role.dream}</span>
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
