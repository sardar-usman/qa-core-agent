import { Link } from 'react-router-dom';
import type { RunRow } from '@/lib/api';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusBadge } from '@/components/StatusBadge';
import { duration, fmtDate, pct, usd } from '@/lib/utils';

/**
 * The runs table, shared by the Runs page and the project page. Every cell
 * is an index row column; a legacy row shows "N explored" because a pre-v2
 * record never carried a shipped count.
 */
export function RunsTable({ runs, hideProject = false }: { runs: RunRow[]; hideProject?: boolean }) {
  const to = (r: RunRow) => `/runs/${encodeURIComponent(r.id)}`;
  return (
    <Table data-testid="runs-table">
      <TableHeader>
        <TableRow>
          <TableHead>Status</TableHead>
          <TableHead>{hideProject ? 'Run' : 'Project'}</TableHead>
          <TableHead className="text-right">Shipped / planned</TableHead>
          <TableHead className="text-right">Cost</TableHead>
          <TableHead className="text-right">Flake rate</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Date</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => (
          <TableRow key={r.id} className="cursor-pointer" data-testid="run-row" data-run-id={r.id}>
            <TableCell><Link to={to(r)} className="block"><StatusBadge status={r.status} /></Link></TableCell>
            <TableCell><Link to={to(r)} className="block">{hideProject ? <div className="mono text-s">{r.id}</div> : <div className="font-semibold">{r.project_name ?? r.project_id}</div>}<div className="mono truncate text-s text-fg-3" title={r.url ?? ''}>{r.url}</div></Link></TableCell>
            <TableCell className="text-right"><Link to={to(r)} className="block"><span className="mono" data-testid="shipped-planned" title={r.status === 'legacy' ? 'Pre-v2 record: scenarios explored, no shipped count' : 'shipped / planned'}>{r.status === 'legacy' ? `${r.generated} explored` : `${r.shipped ?? 0}/${r.planned}`}</span></Link></TableCell>
            <TableCell className="text-right"><Link to={to(r)} className="block money text-cost" data-testid="cost">{usd(r.cost_total)}</Link></TableCell>
            <TableCell className="text-right"><Link to={to(r)} className={`block mono ${r.flake_rate ? 'text-rework' : 'text-fg-2'}`} data-testid="flake-rate">{pct(r.flake_rate)}</Link></TableCell>
            <TableCell className="text-right"><Link to={to(r)} className="block mono text-fg-2">{duration(r.started_at, r.ended_at)}</Link></TableCell>
            <TableCell><Link to={to(r)} className="block text-fg-2">{r.source}</Link></TableCell>
            <TableCell><Link to={to(r)} className="block text-fg-2" title={r.started_at ?? ''}>{fmtDate(r.started_at)}</Link></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
