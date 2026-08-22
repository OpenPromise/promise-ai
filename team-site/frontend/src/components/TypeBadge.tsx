import { NEWS_TYPE_LABELS } from '../api/client';
import type { NewsItem } from '../api/client';

/**
 * 情报类型徽章：对齐参考站 .newsItem .type——
 * 实色 + 斜切 skew(-15deg)（内层反切保持文字正向）；做了什么=青 / 入职=紫 / 牢骚=粉。
 */
export default function TypeBadge({ type }: { type: NewsItem['type'] }) {
  return (
    <span className={`type-badge type-${type}`}>
      <span>{NEWS_TYPE_LABELS[type]}</span>
    </span>
  );
}
