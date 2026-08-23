import { useEffect, useState } from 'react';
import { fetchRoles } from '../api/client';
import type { Role } from '../api/client';

/**
 * 角色介绍：1:1 复刻异环官网 pageRole（2026-08-23 逆向，详见 docs/roles-1to1.md）
 * - 结构：左侧竖排头像导航（参考站 .roleNav + .factionsPrev|Next）+ 整屏角色 slide
 *   （每角色一屏：world-* 氛围背景 + 右侧 2:3 立绘 + 左侧信息区，对应参考站角色视频）
 * - 交互：缩略图点击 / 导航箭头切换，整屏交叉淡化（参考站 Swiper effect:"fade" crossFade，≈1s）
 * - 素材说明：参考站为"角色背景视频（立绘入画）"，我们无视频，用 world-*.png 背景 + 2:3 立绘叠加模拟同等构图；
 *   role_name / role_des 为参考站美术字图，我们用 CSS 文字（名字 + 职务）排版。
 * - 移动端：参考站 /m/ 为"顶部横排导航 + 底部信息面板 + 更多展开"，这里同构降级。
 */
export default function RolesPage() {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [active, setActive] = useState(0);
  // 移动端「展开介绍」（对应参考站 /m/ 的 .roleMoreDes 切换）
  const [expanded, setExpanded] = useState(false);

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

  const count = roles?.length ?? 0;
  const go = (i: number) => setActive(count ? ((i % count) + count) % count : 0);
  const prev = () => setActive((a) => (count ? (a + count - 1) % count : a));
  const next = () => setActive((a) => (count ? (a + 1) % count : a));

  return (
    <section id="roles" className="page-sec roles-page" aria-label="角色介绍">
      <div className="roles-stage">
        {roles === null ? (
          <p className="loading-text">加载中…</p>
        ) : (
          <>
            {/* 整屏角色 slide 组（对应参考站 .roleSwiper，叠放交叉淡化） */}
            <div className="role-slides">
              {roles.map((r, i) => (
                <div
                  key={r.id}
                  className={`role-slide${i === active ? ' is-active' : ''}`}
                  role="group"
                  aria-roledescription="角色"
                  aria-label={`${r.name}：${r.title}`}
                >
                  {/* 氛围背景（对应参考站角色背景视频，用 world 图模拟） */}
                  <div
                    className="role-bg"
                    style={{ backgroundImage: `url(/assets/worlds/${r.id}.png)` }}
                  />
                  <div className="role-bg-veil" aria-hidden="true" />
                  {/* 右侧立绘（对应参考站视频中右侧入画的角色） */}
                  <figure className="role-figure" aria-hidden="true">
                    <img src={r.avatarUrl} alt="" loading="eager" />
                  </figure>
                  {/* 左侧信息区（对应参考站 .role_name / .role_des / .role_text 排版） */}
                  <div className="role-info">
                    <h3 className="role-name" style={{ color: r.accent }}>
                      {r.name}
                    </h3>
                    <span
                      className="role-title-badge"
                      style={{ borderColor: r.accent, color: r.accent }}
                    >
                      {r.title}
                    </span>
                    <div className={`role-text${expanded ? ' is-expanded' : ''}`} tabIndex={0}>
                      <p className="role-bio">{r.bio}</p>
                      <p className="role-dream">
                        <span className="role-dream-label">个人梦想</span>
                        <span className="role-dream-text">{r.dream}</span>
                      </p>
                    </div>
                    <button
                      type="button"
                      className="role-more"
                      aria-expanded={expanded}
                      onClick={() => setExpanded((v) => !v)}
                    >
                      {expanded ? '收起' : '展开介绍'}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* 左侧竖排头像导航 + 上下箭头（参考站 .roleNav 内嵌 .factions_nav + factionsPrev|Next） */}
            <nav className="roles-nav" aria-label="成员切换">
              <button type="button" className="roles-nav-arrow roles-nav-prev" onClick={prev} aria-label="上一个角色">
                ‹
              </button>
              {roles.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  className={`roles-nav-item${i === active ? ' is-active' : ''}`}
                  aria-label={`${r.name}：${r.title}`}
                  aria-current={i === active}
                  onClick={() => go(i)}
                >
                  <img src={r.avatarUrl} alt="" loading="eager" />
                </button>
              ))}
              <button type="button" className="roles-nav-arrow roles-nav-next" onClick={next} aria-label="下一个角色">
                ›
              </button>
            </nav>
          </>
        )}
      </div>
    </section>
  );
}
