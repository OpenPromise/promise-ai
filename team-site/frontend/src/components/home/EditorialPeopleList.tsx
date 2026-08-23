import { HOME_CONTENT } from '../../lib/homeContent';
import type { Role } from '../../api/client';

/**
 * 团队目录（EditorialPeopleList，DESIGN_SPEC §6.4）：
 * 三名成员以编辑式条目出现（序号 / 头像 / 姓名 / 职位 / 职责摘要），
 * 整条作为链接进入 #roles；条目是链接语义，不做不可访问的 div click。
 * 状态：loading / 空 / 成功（API 失败时 client 会回退静态兜底数据）。
 */
export default function EditorialPeopleList({
  roles,
  onNavigate,
}: {
  roles: Role[] | null;
  onNavigate: (id: string) => void;
}) {
  return (
    <div className="home-block home-people">
      <div className="home-grid">
        <div className="home-block-head">
          <p className="home-kicker">{HOME_CONTENT.people.kicker}</p>
          <h2 className="home-block-title">{HOME_CONTENT.people.title}</h2>
          <p className="home-block-desc">{HOME_CONTENT.people.desc}</p>
        </div>

        {roles === null ? (
          <p className="home-block-status">{HOME_CONTENT.loading}</p>
        ) : roles.length === 0 ? (
          <p className="home-block-status">{HOME_CONTENT.signal.empty}</p>
        ) : (
          <ul className="home-people-list">
            {roles.map((r, i) => (
              <li key={r.id}>
                <a
                  className="home-people-item"
                  href="#roles"
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate('roles');
                  }}
                  aria-label={`认识${r.name}，${r.title}`}
                >
                  <span className="home-people-num" aria-hidden="true">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <img
                    className="home-people-avatar"
                    src={r.avatarUrl}
                    alt=""
                    loading="lazy"
                  />
                  <span className="home-people-name">{r.name}</span>
                  <span className="home-people-title">{r.title}</span>
                  <span className="home-people-bio">{r.bio}</span>
                  <span className="home-people-more">
                    {HOME_CONTENT.people.cta}
                    <span aria-hidden="true">→</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
