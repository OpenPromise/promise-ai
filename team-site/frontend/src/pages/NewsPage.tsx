import { useEffect, useState } from 'react';
import { fetchNews, NEWS_TYPE_LABELS } from '../api/client';
import type { NewsItem, NewsType } from '../api/client';

const tabs: { key: NewsType; label: string }[] = [
  { key: 'all', label: '全部' }, { key: 'work', label: '工作' }, { key: 'join', label: '入职' }, { key: 'complaint', label: '牢骚' },
];

export default function NewsPage() {
  const [tab, setTab] = useState<NewsType>('all');
  const [items, setItems] = useState<NewsItem[] | null>(null);
  useEffect(() => { setItems(null); fetchNews(tab).then(setItems); }, [tab]);
  return <section id="signals" className="page-sec content-page signals-page">
    <div className="page-intro"><p className="eyebrow">02 / SIGNALS</p><h1>工作室留下的<br /><em>可读记录。</em></h1><p>按时间、类型和角色阅读已经发生的事。不把普通动态伪装成指标，也不把愿景写成事实。</p></div>
    <div className="filter-row" role="tablist">{tabs.map((item) => <button key={item.key} role="tab" aria-selected={tab === item.key} className={tab === item.key ? 'is-active' : ''} onClick={() => setTab(item.key)}>{item.label}<span>{item.key === 'all' ? 'ALL' : NEWS_TYPE_LABELS[item.key]}</span></button>)}</div>
    <div className="signals-list">{items === null ? <p className="empty-state">正在读取记录…</p> : items.length === 0 ? <p className="empty-state">暂时没有可发布的情报。</p> : items.map((item, i) => <article className="signal-row" key={item.id}><span className="row-index">0{i + 1}</span><span className={`signal-type type-${item.type}`}>{item.type === 'work' ? 'WORK' : item.type === 'join' ? 'JOIN' : 'NOTE'}</span><div><h2>{item.title}</h2><p>{item.content ?? '暂无摘要。'}</p></div><div className="row-meta"><b>{item.author}</b><time>{item.date}</time></div></article>)}</div>
  </section>;
}
