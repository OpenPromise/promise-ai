export default function SectionHead({
  kicker,
  title,
  desc,
}: {
  kicker?: string;
  title: string;
  desc?: string;
}) {
  return (
    <div className="section-head">
      {kicker && <span className="section-kicker">{kicker}</span>}
      <h2 className="section-title">{title}</h2>
      {desc && <p className="section-desc">{desc}</p>}
    </div>
  );
}
