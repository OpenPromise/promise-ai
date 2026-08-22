import { useEffect, useState } from 'react';

/**
 * 加载页：品牌字 + 青色波浪（参考站 loading 波浪文字基因的简化版，style-guide §6）。
 * 固定 ~0.9s 后淡出（不做素材预载等待，避免网络异常时卡死）。
 */
export default function LoadingOverlay() {
  const [phase, setPhase] = useState<'show' | 'fade' | 'done'>('show');

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('fade'), 900);
    const t2 = setTimeout(() => setPhase('done'), 1500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  if (phase === 'done') return null;

  return (
    <div className={`loading-overlay${phase === 'fade' ? ' is-fading' : ''}`} aria-hidden="true">
      <div className="loading-brand">
        <span className="loading-name">世界第一 AI 工作室</span>
        <span className="loading-wave">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}
