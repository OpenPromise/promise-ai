export default function Footer({ onHome }: { onHome: () => void }) {
  return (
    <footer className="footer">
      <div><span className="footer-mark">P</span> PROMISE AI / TASKROOM</div>
      <div className="footer-note">任务、Agent、工具、记忆与下一步。</div>
      <button type="button" onClick={onHome}>回到起点 ↑</button>
    </footer>
  );
}
