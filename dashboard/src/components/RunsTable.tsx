import { Link, useNavigate } from 'react-router-dom';
import type { RunRow } from '@/lib/api';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusBadge } from '@/components/StatusBadge';
import { Term, Tip } from '@/components/Term';
import { duration, fmtDate, pct, usd } from '@/lib/utils';

/**
 * The runs table, shared by the Runs page and the project page. Every cell
 * is an index row column; a legacy row shows "N explored" because a pre-v2
 * record never carried a shipped count. Cost keeps 4 decimals here: it is
 * compared with the audit report. The whole row opens the run; the name is
 * also a real link for the keyboard.
 */
export function RunsTable({ runs, hideProject = false }: { runs: RunRow[]; hideProject?: boolean }) {
  const navigate = useNavigate();
  const to = (r: RunRow) => `/runs/${encodeURIComponent(r.id)}`;
  return (
    <Table data-testid="runs-table">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-[200px]">Status</TableHead>
          <TableHead>{hideProject ? 'Run' : 'Project'}</TableHead>
          <TableHead className="text-right"><Term term="shippedPlanned">Shipped / planned</Term></TableHead>
          <TableHead className="text-right"><Term term="cost">Cost</Term></TableHead>
          <TableHead className="text-right"><Term term="flakeRate">Flake rate</Term></TableHead>
          <TableHead className="text-right"><Term term="duration">Duration</Term></TableHead>
          <TableHead><Term term="source">Source</Term></TableHead>
          <TableHead><Term term="date">Date</Term></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => (
          <TableRow key={r.id} className="cursor-pointer" data-testid="run-row" data-run-id={r.id} onClick={(e) => { if ((e.target as HTMLElement).closest('a, [data-glossary], [data-tip]')) return; navigate(to(r)); }}>
            <TableCell><StatusBadge status={r.status} /></TableCell>
            <TableCell>
              <Link to={to(r)} className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="run-link">
                {hideProject ? <div className="mono text-s text-fg">{r.id}</div> : <div className="font-semibold text-fg">{r.project_name ?? r.project_id}</div>}
                <div className="mono truncate text-s text-fg-3" title={r.url ?? ''}>{r.url}</div>
              </Link>
            </TableCell>
            <TableCell className="text-right"><span className="mono text-fg" data-testid="shipped-planned">{r.status === 'legacy' ? <Term term="explored">{r.generated} explored</Term> : `${r.shipped ?? 0}/${r.planned}`}</span></TableCell>
            <TableCell className="text-right"><span className="money text-cost" data-testid="cost">{usd(r.cost_total)}</span></TableCell>
            <TableCell className="text-right"><span className={`mono ${r.flake_rate ? 'text-rework' : 'text-fg-2'}`} data-testid="flake-rate">{pct(r.flake_rate)}</span></TableCell>
            <TableCell className="text-right"><span className="mono text-fg-2" data-testid="duration">{duration(r.started_at, r.ended_at)}</span></TableCell>
            <TableCell><span className="text-fg-2" data-testid="run-source">{r.source ?? 'unknown'}</span></TableCell>
            <TableCell><Tip text={r.started_at ?? 'start time not recorded'} className="text-fg-2">{fmtDate(r.started_at)}</Tip></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
