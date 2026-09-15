import { Link } from 'react-router-dom';
import type { ProjectTrends } from '@/lib/api';
import { fmtDate, usd } from '@/lib/utils';

/**
 * Three small charts over a project's completed runs, in run order, from
 * index rows only: tests shipped, total cost, flake rate. Points only, each
 * labeled with its row value. No smoothing, no averages, no projections.
 * Legacy, stopped, empty and failed runs are not charted and the caption
 * says so.
 */
export function Trends({ trends }: { trends: ProjectTrends }) {
  const pts = trends.points;
  const ex = trends.excluded;
  const excluded: string[] = [];
  if (ex.legacy) excluded.push(`${ex.legacy} pre-v2 run${ex.legacy === 1 ? '' : 's'} not charted`);
  if (ex.stopped) excluded.push(`${ex.stopped} stopped run${ex.stopped === 1 ? '' : 's'} not charted`);
  if (ex.empty) excluded.push(`${ex.empty} empty run${ex.empty === 1 ? '' : 's'} not charted`);
  if (ex.failed) excluded.push(`${ex.failed} failed run${ex.failed === 1 ? '' : 's'} not charted`);
  const caption = `${pts.length} completed run${pts.length === 1 ? '' : 's'}${excluded.length ? '; ' + excluded.join('; ') : ''}`;
  if (pts.length === 0) {
    return <div className="rounded-lg border border-dashed border-line-strong bg-bg-1 px-4 py-3 text-s text-fg-2" data-testid="trends-empty">No completed runs to chart. <span data-testid="trends-caption">{caption}</span></div>;
  }
  return (
    <div className="flex flex-col gap-2" data-testid="trends">
      <div className="text-s text-fg-2" data-testid="trends-caption">{caption}{pts.length === 1 ? '. A trend needs two runs; this is the single point.' : ''}</div>
      <div className="grid gap-3 md:grid-cols-3">
        <Chart title="tests shipped" metric="shipped" points={pts.map((p) => ({ run_id: p.run_id, at: p.started_at, value: p.shipped ?? 0, label: String(p.shipped ?? 0) }))} color="hsl(var(--pass))" />
        <Chart title="total cost" metric="cost" points={pts.map((p) => ({ run_id: p.run_id, at: p.started_at, value: p.cost_total, label: usd(p.cost_total) }))} color="hsl(var(--cost))" />
        <Chart title="flake rate" metric="flake" points={pts.map((p) => ({ run_id: p.run_id, at: p.started_at, value: p.flake_rate ?? 0, label: p.flake_rate == null ? 'n/a' : `${(p.flake_rate * 100).toFixed(1)}%` }))} color="hsl(var(--rework))" fixedMax={1} />
      </div>
    </div>
  );
}

function Chart({ title, metric, points, color, fixedMax }: { title: string; metric: string; points: Array<{ run_id: string; at: string | null; value: number; label: string }>; color: string; fixedMax?: number }) {
  const w = 320, h = 120, padX = 28, padTop = 22, padBottom = 26;
  // The axis always starts at zero; shipped and cost scale to their maximum, flake rate spans 0 to 100%.
  const min = 0;
  const max = fixedMax ?? Math.max(...points.map((p) => p.value), 0);
  const x = (i: number) => points.length === 1 ? w / 2 : padX + (i / (points.length - 1)) * (w - padX * 2);
  const y = (v: number) => max === 0 ? h - padBottom : h - padBottom - ((v - min) / max) * (h - padTop - padBottom);
  return (
    <div className="rounded-lg border border-line bg-bg-1 p-3" data-testid="trend-chart" data-metric={metric} data-axis-min={min} data-axis-max={max}>
      <div className="text-s font-semibold text-fg">{title}</div>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${title} per completed run`} className="mt-1">
        <line x1={padX} x2={w - padX} y1={h - padBottom} y2={h - padBottom} stroke="hsl(var(--line-strong))" strokeWidth="1" />
        {points.map((p, i) => (
          <g key={p.run_id} data-testid="trend-point" data-run-id={p.run_id} data-value={p.value} data-label={p.label}>
            <circle cx={x(i)} cy={y(p.value)} r="4" fill={color} />
            <text x={x(i)} y={y(p.value) - 8} textAnchor="middle" fontSize="10" fontFamily="ui-monospace, monospace" fill="hsl(var(--text))">{p.label}</text>
            <text x={x(i)} y={h - padBottom + 14} textAnchor="middle" fontSize="9" fill="hsl(var(--text-2))">{fmtDate(p.at)}</text>
          </g>
        ))}
      </svg>
      <div className="flex flex-wrap gap-2 text-s text-fg-3">{points.map((p) => <Link key={p.run_id} to={`/runs/${encodeURIComponent(p.run_id)}`} className="mono hover:underline" title={p.run_id}>{p.run_id.slice(0, 15)}</Link>)}</div>
    </div>
  );
}
