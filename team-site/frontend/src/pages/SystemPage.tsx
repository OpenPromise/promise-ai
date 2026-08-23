export default function SystemPage({ onNavigate }: { onNavigate: (id: string) => void }) {
  const steps = [
    ['01', '接收任务', '需求进入小夜的上下文，不急着给答案。'],
    ['02', '理解与路由', '判断目标、约束和最适合的工作节点。'],
    ['03', '调用工具', 'Agent 读写文件、查询信息、执行动作。'],
    ['04', '返回结果', '结果、失败、权限和取消都被明确记录。'],
    ['05', '继续向前', '记忆、调度和下一次任务让工作不止一轮。'],
  ];
  return <section id="system" className="page-sec content-page system-page">
    <div className="page-intro"><p className="eyebrow">04 / SYSTEM</p><h1>不是聊天窗口，<br /><em>是一条执行链。</em></h1><p>Promise AI 的核心不是一个更会说话的界面，而是让 Agent 有上下文、有工具、有结果、有下一步。</p></div>
    <div className="flow-grid">{steps.map(([num, title, text], i) => <article key={num} className="flow-step"><span>{num}</span><div><h2>{title}</h2><p>{text}</p></div>{i < steps.length - 1 && <b>→</b>}</article>)}</div>
    <div className="system-bottom"><div><p className="eyebrow">REAL CAPABILITIES</p><h2>工具执行 · 记忆 · 调度<br />微信通道 · 子代理协作</h2></div><button className="button button-primary" onClick={() => onNavigate('signals')}>查看工作证据 <span>↗</span></button></div>
  </section>;
}
