import { Link } from 'react-router-dom';
import type { ProjectCoverage, RuleStatus } from '@/lib/api';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Term, Tip } from '@/components/Term';
import { fmtDate } from '@/lib/utils';

/**
 * Requirements coverage across a project's SRS runs, read from the
 * rule_coverage rows the indexer copied from each run's rule-coverage.json.
 * Every rule id seen, its latest classification with the run it came from,
 * the run that last covered it, and how many SRS runs covered it. The rules
 * not automated in the latest run are one line of anchors to their rows.
 * Dates, counts and "x of y" are the UI sans with tabular figures; mono is
 * kept for run ids only (in the tooltips).
 */

const STATUS_LABEL: Record<RuleStatus, string> = { covered: 'covered', planned_but_dropped: 'planned, dropped', planned_not_explored: 'planned, not explored', not_planned: 'not planned' };
const STATUS_VARIANT: Record<RuleStatus, 'pass' | 'rework' | 'neutral' | 'reject'> = { covered: 'pass', planned_but_dropped: 'reject', planned_not_explored: 'rework', not_planned: 'neutral' };

export function CoverageTable({ coverage }: { coverage: ProjectCoverage }) {
  if (coverage.srs_runs === 0) {
    return <div className="rounded-lg border border-dashed border-line-strong bg-bg-1 px-4 py-3 text-s text-fg-2" data-testid="no-srs">No SRS runs. Attach an SRS on the <Link to="/terminal" className="text-accent underline">Terminal page</Link> to get requirements coverage.</div>;
  }
  const covered = coverage.rules.filter((r) => r.latest_status === 'covered').length;
  return (
    <div className="flex flex-col gap-3" data-testid="coverage">
      <div className="text-s text-fg-2">
        <div><span className="tabular-nums text-fg" data-testid="coverage-covered">{covered}</span> of <span className="tabular-nums text-fg" data-testid="coverage-total">{coverage.rules.length}</span> rules covered in the latest classification · <span className="tabular-nums text-fg" data-testid="coverage-srs-runs">{coverage.srs_runs}</span> SRS run{coverage.srs_runs === 1 ? '' : 's'}</div>
        <div className="mt-1" data-testid="not-automated">
          {coverage.not_automated.length === 0
            ? 'Every rule reported in the latest classification is covered.'
            : (<>Not automated in the latest run: {coverage.not_automated.map((u, i) => (
              <span key={u.rule_id}>{i ? ', ' : ''}<a href={`#rule-${u.rule_id}`} className="rounded-sm font-semibold text-fg underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="not-automated-row" data-rule-id={u.rule_id}>{u.rule_id}</a></span>
            ))}</>)}
        </div>
      </div>
      <Table data-testid="coverage-table">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Rule</TableHead>
            <TableHead>Text</TableHead>
            <TableHead>Latest classification</TableHead>
            <TableHead>Last covered</TableHead>
            <TableHead className="text-right"><Term term="runsCovered">Runs covered</Term></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {coverage.rules.map((r) => (
            <TableRow key={r.rule_id} id={`rule-${r.rule_id}`} className="scroll-mt-28" data-testid="rule-row" data-rule-id={r.rule_id} data-status={r.latest_status}>
              <TableCell><div className="font-semibold text-fg">{r.rule_id}</div>{r.feature ? <div className="text-xs text-fg-3">{r.feature}</div> : null}</TableCell>
              <TableCell className="max-w-md text-s text-fg-2">{r.text ?? <span className="text-fg-3">no text recorded</span>}</TableCell>
              <TableCell>
                <Badge variant={STATUS_VARIANT[r.latest_status]} data-testid="rule-status">{STATUS_LABEL[r.latest_status]}</Badge>
                <div className="mt-1 text-xs text-fg-3">
                  <Tip asChild text={r.latest_run_id} mono>
                    <Link to={`/runs/${encodeURIComponent(r.latest_run_id)}`} className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="rule-latest-run">{fmtDate(r.latest_run_at)} run</Link>
                  </Tip>
                </div>
              </TableCell>
              <TableCell className="text-s">
                {r.last_covered_run_id ? (
                  <>
                    <Tip asChild text={r.last_covered_run_id} mono>
                      <Link to={`/runs/${encodeURIComponent(r.last_covered_run_id)}`} className="rounded-sm text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="rule-last-covered">{fmtDate(r.last_covered_at)}</Link>
                    </Tip>
                    {r.last_covered_scenarios.length ? <div className="text-fg-3">{r.last_covered_scenarios.join(', ')}</div> : null}
                  </>
                ) : <span className="text-fg-3" data-testid="rule-last-covered">never</span>}
              </TableCell>
              <TableCell className="text-right tabular-nums text-fg-2" data-testid="rule-runs-covered"><span className="text-fg">{r.runs_covered}</span> of {r.runs_reported}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
