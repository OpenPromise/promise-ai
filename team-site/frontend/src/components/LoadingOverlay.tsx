import { useEffect, useState } from 'react';

const BRAND = '世界第一 AI 工作室';
const SUB = 'AI TEAM · EST. 2026';
const DURATION_SHOW = 1100; // 波浪动画时长
const DURATION_FADE = 500; // 淡出时长

/**
 * 加载页：对齐参考站——品牌字母逐字波浪跳动（textWavy 基因）+ 青色进度线 + 三点。
 * 固定 ~1.6s 后淡出主站（不做素材预载等待，避免网络异常卡死）。
 */
export default function LoadingOverlay() {
  const [phase, setPhase] = useState<'show' | 'fade' | 'done'>('show');

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('fade'), DURATION_SHOW);
    const t2 = setTimeout(() => setPhase('done'), DURATION_SHOW + DURATION_FADE);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  if (phase === 'done') return null;

  return (
    <div className={`loading-overlay${phase === 'fade' ? ' is-fading' : ''}`} aria-hidden="true">
      <div className="loading-brand">
        <p className="loading-sub">{SUB}</p>
        <h1 className="loading-name" aria-label={BRAND}>
          {BRAND.split('').map((ch, i) => (
            <span key={`${ch}-${i}`} className="loading-letter" style={{ animationDelay: `${0.06 * i}s` }}>
              {ch}
            </span>
          ))}
          <span className="loading-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </h1>
        <div className="loading-bar">
          <i />
        </div>
      </div>
    </div>
  );
}
