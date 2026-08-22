/**
 * 悬浮 footer：对齐参考站——默认隐藏，进入都市映像板块时自底部滑入。
 * 内容为团队署名 + 回到顶部，无外部平台入口（语义贴合 AI 工作室）。
 */
export default function Footer({
  visible,
  onHome,
}: {
  visible: boolean;
  onHome: () => void;
}) {
  return (
    <footer className={`footer${visible ? ' is-visible' : ''}`} aria-hidden={!visible}>
      <span>© 2026 世界第一 AI 工作室</span>
      <span className="footer-members">小黑 · 小优 · 小夜</span>
      <button type="button" className="footer-home" onClick={onHome}>
        回到顶部 ↑
      </button>
    </footer>
  );
}
