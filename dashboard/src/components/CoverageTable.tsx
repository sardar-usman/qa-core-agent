import { Link } from 'react-router-dom';
import type { ProjectCoverage, RuleStatus } from '@/lib/api';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { fmtDate } from '@/lib/utils';

/**
 * Requirements coverage across a project's SRS runs, read from the
 * rule_coverage rows the indexer copied from each run's rule-coverage.json.
 * Every rule id seen, its latest classification, the run that last covered
 * it, and the considered-not-automated list with the recorded reasons.
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
      <div className="text-s text-fg-2"><span className="mono text-fg" data-testid="coverage-covered">{covered}</span> of <span className="mono text-fg" data-testid="coverage-total">{coverage.rules.length}</span> rules covered in the latest classification · <span className="mono text-fg" data-testid="coverage-srs-runs">{coverage.srs_runs}</span> SRS run{coverage.srs_runs === 1 ? '' : 's'}</div>
      <Table data-testid="coverage-table">
        <TableHeader>
          <TableRow>
            <TableHead>Rule</TableHead>
            <TableHead>Text</TableHead>
            <TableHead>Latest classification</TableHead>
            <TableHead>Last covered</TableHead>
            <TableHead className="text-right">Runs covered / reported</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {coverage.rules.map((r) => (
            <TableRow key={r.rule_id} data-testid="rule-row" data-rule-id={r.rule_id} data-status={r.latest_status}>
              <TableCell className="mono font-semibold">{r.rule_id}{r.feature ? <div className="text-s font-normal text-fg-3">{r.feature}</div> : null}</TableCell>
              <TableCell className="max-w-md text-s text-fg-2">{r.text ?? <span className="text-fg-3">no text recorded</span>}</TableCell>
              <TableCell><Badge variant={STATUS_VARIANT[r.latest_status]} data-testid="rule-status">{STATUS_LABEL[r.latest_status]}</Badge><div className="mt-1 text-s text-fg-3">in <Link to={`/runs/${encodeURIComponent(r.latest_run_id)}`} className="mono hover:underline">{fmtDate(r.latest_run_at)}</Link></div></TableCell>
              <TableCell className="text-s">
                {r.last_covered_run_id ? (<><Link to={`/runs/${encodeURIComponent(r.last_covered_run_id)}`} className="mono text-fg hover:underline" data-testid="rule-last-covered" title={r.last_covered_run_id}>{fmtDate(r.last_covered_at)}</Link>{r.last_covered_scenarios.length ? <div className="text-fg-3">{r.last_covered_scenarios.join(', ')}</div> : null}</>) : <span className="text-fg-3" data-testid="rule-last-covered">never</span>}
              </TableCell>
              <TableCell className="mono text-right text-fg-2">{r.runs_covered} / {r.runs_reported}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div>
        <h3 className="text-s font-semibold text-fg">Considered, not automated <span className="mono font-normal text-fg-3" data-testid="not-automated-count">{coverage.not_automated.length}</span></h3>
        {coverage.not_automated.length === 0 ? <div className="mt-1 text-s text-fg-2">Every rule reported in the latest classification is covered.</div> : (
          <ul className="mt-1 flex flex-col" data-testid="not-automated">
            {coverage.not_automated.map((u) => (
              <li key={u.rule_id} className="flex flex-wrap items-baseline gap-2 border-t border-line/60 py-1 text-s first:border-t-0" data-testid="not-automated-row">
                <span className="mono font-semibold text-fg">{u.rule_id}</span>
                <span className="text-fg">{u.text ?? 'no text recorded'}</span>
                <Badge variant={STATUS_VARIANT[u.reason]}>{STATUS_LABEL[u.reason]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
