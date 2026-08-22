import { NEWS_TYPE_LABELS } from '../api/client';
import type { NewsItem } from '../api/client';

/** 情报类型徽章：做了什么=青 / 入职=紫 / 牢骚=粉（style-guide §5） */
export default function TypeBadge({ type }: { type: NewsItem['type'] }) {
  return <span className={`type-badge type-${type}`}>{NEWS_TYPE_LABELS[type]}</span>;
}
