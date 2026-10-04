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
 * compared with the audit report. Numbers are right aligned in tabular
 * figures. The whole row opens the run; the name is also a real link for
 * the keyboard. On the project page (hideProject) the row shows the last 6
 * characters of the run id in mono with the full id in a tooltip, and no
 * URL, since the host is the project's.
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
          <TableRow key={r.id} className="h-14 cursor-pointer" data-testid="run-row" data-run-id={r.id} onClick={(e) => { if ((e.target as HTMLElement).closest('a, [data-glossary], [data-tip]')) return; navigate(to(r)); }}>
            <TableCell className="py-2"><StatusBadge status={r.status} /></TableCell>
            <TableCell className="py-2">
              {hideProject ? (
                <Tip asChild text={r.id} mono>
                  <Link to={to(r)} className="mono inline-block rounded-sm text-m text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="run-link" data-run-id-short={r.id.slice(-6)}>…{r.id.slice(-6)}</Link>
                </Tip>
              ) : (
                <Tip asChild text={r.url ?? 'no URL recorded'}>
                  <Link to={to(r)} className="block min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="run-link">
                    <div className="font-semibold text-fg">{r.project_name ?? r.project_id}</div>
                    <div className="truncate text-s text-fg-3" data-testid="run-url">{r.url}</div>
                  </Link>
                </Tip>
              )}
            </TableCell>
            <TableCell className="py-2 text-right"><span className="tabular-nums text-fg" data-testid="shipped-planned">{r.status === 'legacy' ? <Term term="explored">{r.generated} explored</Term> : `${r.shipped ?? 0}/${r.planned}`}</span></TableCell>
            <TableCell className="py-2 text-right"><span className="money text-cost" data-testid="cost">{usd(r.cost_total)}</span></TableCell>
            <TableCell className="py-2 text-right"><span className={`tabular-nums ${r.flake_rate ? 'text-rework' : 'text-fg-2'}`} data-testid="flake-rate">{pct(r.flake_rate)}</span></TableCell>
            <TableCell className="py-2 text-right"><span className="tabular-nums text-fg-2" data-testid="duration">{duration(r.started_at, r.ended_at)}</span></TableCell>
            <TableCell className="py-2"><span className="text-fg-2" data-testid="run-source">{r.source ?? 'unknown'}</span></TableCell>
            <TableCell className="py-2"><Tip text={r.started_at ?? 'start time not recorded'} className="text-fg-2">{fmtDate(r.started_at)}</Tip></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
