import { Link, useNavigate } from 'react-router-dom';
import type { RunRow } from '@/lib/api';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusBadge } from '@/components/StatusBadge';
import { Term, Tip } from '@/components/Term';
import { duration, exactMoney, formatDate, formatDateTime, formatMoney, pct } from '@/lib/format';

/**
 * The runs table, shared by the Runs page and the project page. Every cell
 * is an index row column; a legacy row shows "N explored" because a pre-v2
 * record never carried a shipped count. Cost shows 2 decimals with the exact
 * report value in its tooltip, like the cards. Numbers are right aligned in tabular
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
          <TableRow key={r.id} className="cursor-pointer" data-testid="run-row" data-run-id={r.id} onClick={(e) => { if ((e.target as HTMLElement).closest('a, [data-glossary], [data-tip]')) return; navigate(to(r)); }}>
            <TableCell><StatusBadge status={r.status} /></TableCell>
            <TableCell>
              {hideProject ? (
                <Tip asChild text={r.id} mono>
                  <Link to={to(r)} className="mono inline-block rounded-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="run-link" data-run-id-short={r.id.slice(-6)}>…{r.id.slice(-6)}</Link>
                </Tip>
              ) : (
                <Tip asChild text={r.url ?? 'no URL recorded'}>
                  <Link to={to(r)} className="block min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="run-link">
                    <div className="font-medium text-fg">{r.project_name ?? r.project_id}</div>
                    <div className="truncate text-small text-fg-2" data-testid="run-url">{r.url}</div>
                  </Link>
                </Tip>
              )}
            </TableCell>
            <TableCell className="text-right"><span className="tabular-nums text-fg" data-testid="shipped-planned">{r.status === 'legacy' ? <Term term="explored">{r.generated} explored</Term> : `${r.shipped === null ? 'n/a' : r.shipped}/${r.planned}`}</span></TableCell>
            <TableCell className="text-right"><Tip text={`exact: ${exactMoney(r.cost_total)}`}><span className="money text-fg" data-testid="cost">{formatMoney(r.cost_total)}</span></Tip></TableCell>
            <TableCell className="text-right"><span className="tabular-nums text-fg" data-testid="flake-rate">{pct(r.flake_rate)}</span></TableCell>
            <TableCell className="text-right"><span className="tabular-nums text-fg" data-testid="duration">{duration(r.started_at, r.ended_at)}</span></TableCell>
            <TableCell><span className="text-fg-2" data-testid="run-source">{r.source ?? 'unknown'}</span></TableCell>
            <TableCell><Tip text={formatDateTime(r.started_at)} className="text-fg-2">{formatDate(r.started_at)}</Tip></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
