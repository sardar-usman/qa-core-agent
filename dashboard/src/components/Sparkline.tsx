/** A tiny line for a series of percents (0..100). Renders nothing without data. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length === 0) return null;
  const w = 96, h = 24, pad = 2;
  const pts = values.map((v, i) => {
    const x = values.length === 1 ? w / 2 : pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - (Math.max(0, Math.min(100, v)) / 100) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={className} aria-label={`coverage ${values[values.length - 1]}%`}>
      <polyline fill="none" stroke="hsl(var(--accent))" strokeWidth="1.5" points={pts.join(' ')} />
      <circle cx={pts[pts.length - 1]!.split(',')[0]} cy={pts[pts.length - 1]!.split(',')[1]} r="2" fill="hsl(var(--accent))" />
    </svg>
  );
}
