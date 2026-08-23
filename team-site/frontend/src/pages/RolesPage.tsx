import { useEffect, useState } from 'react';
import { fetchRoles } from '../api/client';
import type { Role } from '../api/client';

export default function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  useEffect(() => { fetchRoles().then(setRoles); }, []);
  return <section id="team" className="page-sec content-page team-page">
    <div className="page-intro"><p className="eyebrow">03 / TEAM</p><h1>四个角色，<br /><em>一条工作链。</em></h1><p>角色拥有不同职责、工具和工作场景。小夜是中枢，不是唯一主角；每个节点都要对自己的产出负责。</p></div>
    <div className="team-grid">{roles.map((role) => <article className="team-card" key={role.id}><div className="team-portrait"><img src={role.avatarUrl} alt="" /></div><div className="team-details"><p className="eyebrow">{role.id.toUpperCase()} / AGENT NODE</p><h2>{role.name}</h2><h3>{role.title}</h3><p>{role.bio}</p><div className="team-footer"><span>职责节点</span><span>↗</span></div></div></article>)}</div>
  </section>;
}
