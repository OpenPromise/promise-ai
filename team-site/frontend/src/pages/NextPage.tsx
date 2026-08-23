export default function NextPage({ onNavigate }: { onNavigate: (id: string) => void }) {
  return <section id="next" className="page-sec content-page next-page">
    <div className="next-frame"><p className="eyebrow">06 / NEXT STEP</p><h1>如果你想知道<br /><em>下一步会发生什么。</em></h1><p>联系方式、合作方式和更具体的业务入口，正在等待内容确认。在它们准备好之前，你可以先从工作方式和情报开始认识 Promise AI。</p><div className="next-actions"><button className="button button-primary" onClick={() => onNavigate('system')}>看工作方式 <span>↗</span></button><button className="button button-ghost" onClick={() => onNavigate('signals')}>读情报记录</button></div><div className="pending-note"><span>CONTENT STATUS</span><b>联系入口待内容确认</b><small>不展示虚假的邮箱、表单或服务承诺。</small></div></div>
  </section>;
}
