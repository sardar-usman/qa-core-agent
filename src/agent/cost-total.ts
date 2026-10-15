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
const cents = (v: number): string => `$${v.toFixed(2)}`;

/**
 * The cost closeout grace (invariant 30): a scenario in progress that holds a
 * passed assertion may keep closing while the spend stays within ceiling plus
 * this. Like the ceiling, it bounds when a call may START, not its size.
 * Lives here so the cost line can name it; runtime.ts re-exports it.
 */
export const COST_CLOSEOUT_GRACE_USD = 0.10;

/**
 * The words a cost line carries when the total is over the stated ceiling,
 * or null when it is not (or the report records no ceiling): how much over,
 * the terms that run outside the explorer budget (planner and Critic always,
 * the requirements map and the Stabilizer when they spent a cent or more),
 * and the closeout grace. Two decimals. Runs 1 to 6 ended 0.5 to 1.5 percent
 * over the $6 ceiling with nothing on the line to say why (invariant 73).
 */
export function overCeilingText(report: CostReport): string | null {
  const ceiling = report.cost?.ceilingUsd;
  if (typeof ceiling !== 'number' || !Number.isFinite(ceiling)) return null;
  const total = totalCost(report);
  // Judged on the printed cents, so the line never reads "$0.00 over".
  if (Math.round(total * 100) <= Math.round(ceiling * 100)) return null;
  const c = report.cost ?? {};
  const outside = [`planner ${cents(c.plannerUsd ?? 0)}`];
  if (hasRequirementsCost(report) && (c.requirementsUsd as number) >= 0.005) outside.push(`map ${cents(c.requirementsUsd as number)}`);
  const stabilizer = report.stability?.stabilizerCostUsd ?? 0;
  if (stabilizer >= 0.005) outside.push(`Stabilizer ${cents(stabilizer)}`);
  outside.push(`Critic ${cents(c.criticUsd ?? 0)}`);
  const list = outside.length === 1 ? outside[0]! : `${outside.slice(0, -1).join(', ')} and ${outside.at(-1)!}`;
  return `Cost: ${cents(total)} total, ${cents(total - ceiling)} over the ${cents(ceiling)} ceiling (${list} run outside it; closeout grace up to ${cents(COST_CLOSEOUT_GRACE_USD)})`;
}

/**
 * The printed cost line, shared by the CLI and the gateway:
 * `Cost: $T total (planner $a, explorer $b, critic $c[, stabilizer $s], map $m)`.
 * The stabilizer term is named only when it spent something (it was never
 * on the line before, and the total has always counted it in the index).
 * The map term is named whenever the report carries the key; without the
 * key the line ends with REQUIREMENTS_COST_NOT_RECORDED. A total over the
 * recorded ceiling prints overCeilingText instead (invariant 73); under it,
 * or with no ceiling recorded, the line is unchanged.
 */
export function costLine(report: CostReport): string {
  const over = overCeilingText(report);
  if (over) return over;
  const c = report.cost ?? {};
  const parts = [`planner $${money(c.plannerUsd)}`, `explorer $${money(c.usd)}`, `critic $${money(c.criticUsd)}`];
  const stabilizer = report.stability?.stabilizerCostUsd ?? 0;
  if (stabilizer > 0) parts.push(`stabilizer $${money(stabilizer)}`);
  const recorded = hasRequirementsCost(report);
  if (recorded) parts.push(`map $${money(c.requirementsUsd)}`);
  return `Cost: $${totalCost(report).toFixed(4)} total (${parts.join(', ')})${recorded ? '' : ` ${REQUIREMENTS_COST_NOT_RECORDED}`}`;
}
