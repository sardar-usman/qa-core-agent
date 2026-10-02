/**
 * The ONE place a run's cost total is summed.
 *
 * Every surface that prints or stores a total (the CLI cost line, the
 * gateway cost line, the host memory record, the SQLite index, the run
 * detail cost split, the dashboard session chip through the run_report
 * message) reads it from here, so a total always equals the sum of the
 * lines it is made of (invariant 50). Run 44cb3d printed $6.0912 while the
 * requirements map build had cost $0.0048 more: the CLI, the gateway and
 * the index each summed their own three or four terms and none had a term
 * for the map.
 *
 * The terms: explorer (`cost.usd`, which includes the repair pass), planner,
 * critic, stabilizer (`stability.stabilizerCostUsd`) and the requirements
 * map (`cost.requirementsUsd`: the build cost when the map was built this
 * run, 0 when it was reused from the cache or no SRS was given). A report
 * written before `requirementsUsd` existed has no key: its total is the old
 * four-term total and `costLine` says so instead of implying the map was
 * included (standing rule 2).
 */
import type { RunReport } from './trace.js';

/** The fields the total reads; a partial report (the disk indexer) qualifies. */
export interface CostReport {
  cost?: Partial<RunReport['cost']> | undefined;
  stability?: { stabilizerCostUsd?: number | undefined } | null | undefined;
}

/** Appended to a cost line for a report with no `cost.requirementsUsd` key. */
export const REQUIREMENTS_COST_NOT_RECORDED = '(requirements map cost not recorded on this report)';

/** True when the report records the requirements map cost (every run written since the field existed). */
export function hasRequirementsCost(report: CostReport): boolean {
  return typeof report.cost?.requirementsUsd === 'number' && Number.isFinite(report.cost.requirementsUsd);
}

/** explorer (incl. repair) + planner + critic + stabilizer + requirements map (0 when the key is absent). */
export function totalCost(report: CostReport): number {
  const c = report.cost ?? {};
  return (c.usd ?? 0) + (c.plannerUsd ?? 0) + (c.criticUsd ?? 0) + (report.stability?.stabilizerCostUsd ?? 0) + (hasRequirementsCost(report) ? (c.requirementsUsd as number) : 0);
}

const money = (v: number | undefined): string => (v ?? 0).toFixed(4);

/**
 * The printed cost line, shared by the CLI and the gateway:
 * `Cost: $T total (planner $a, explorer $b, critic $c[, stabilizer $s], map $m)`.
 * The stabilizer term is named only when it spent something (it was never
 * on the line before, and the total has always counted it in the index).
 * The map term is named whenever the report carries the key; without the
 * key the line ends with REQUIREMENTS_COST_NOT_RECORDED.
 */
export function costLine(report: CostReport): string {
  const c = report.cost ?? {};
  const parts = [`planner $${money(c.plannerUsd)}`, `explorer $${money(c.usd)}`, `critic $${money(c.criticUsd)}`];
  const stabilizer = report.stability?.stabilizerCostUsd ?? 0;
  if (stabilizer > 0) parts.push(`stabilizer $${money(stabilizer)}`);
  const recorded = hasRequirementsCost(report);
  if (recorded) parts.push(`map $${money(c.requirementsUsd)}`);
  return `Cost: $${totalCost(report).toFixed(4)} total (${parts.join(', ')})${recorded ? '' : ` ${REQUIREMENTS_COST_NOT_RECORDED}`}`;
}
