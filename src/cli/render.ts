import type { AgentEvent } from '../agent/runtime.js';
import type { RunReport } from '../agent/trace.js';
import { refusedNote, renderReconciliation } from '../agent/reconcile.js';
import { renderRuleCoverage } from '../agent/rule-coverage.js';
import { costLine } from '../agent/cost-total.js';

/**
 * The CLI's console renderer: every AgentEvent of a run becomes the lines
 * `npm run explore` prints, and the end-of-run summary is built from the
 * final report. src/cli/explore.ts prints through it, and
 * scripts/render-events.ts replays a run's events.jsonl through it, so a
 * smoke can spawn the exact renderer the CLI uses (invariant 72).
 */

/** Messages at or above this length are cut, unless they are always printed whole. */
export const MESSAGE_CAP = 240;

/** What a cut message ends with: the whole text is in the run's events.jsonl. */
export const CUT_MARKER = ' ... (full line in events.jsonl)';

/**
 * Messages printed whole whatever their length: the repair pass decision
 * line (invariant 38; run 44cb3d's never reached the terminal, eaten by the
 * old 240-character drop) and the state probe lines (invariant 71). The
 * resume hint is printed whole too, once, as the last line of the run, by
 * the CLI itself (invariant 40); its mid-run copies are suppressed here.
 */
const WHOLE_PREFIXES = ['repair pass:', 'repair pass skipped:', 'State probe "'];

/**
 * The console line for one runtime message: null only for the mid-run copy
 * of the resume hint (printed once at the end). Otherwise the message is
 * printed whole, or cut at the cap with CUT_MARKER; never dropped. The old
 * renderer dropped every message of 240 characters or more.
 */
export function messageLine(text: string): string | null {
  if (text.startsWith('Run stopped:')) return null;
  const t = text.trim();
  if (t.length < MESSAGE_CAP || WHOLE_PREFIXES.some((p) => t.startsWith(p))) return t;
  return t.slice(0, MESSAGE_CAP) + CUT_MARKER;
}

export interface EventRendererOptions {
  /** How many stages the run has (3 plus replay plus stability), for the "[i/N]" headings. */
  totalStages: number;
  /** Whether replay runs: the stability stage is numbered 5 with it, 4 without. */
  replay: boolean;
  /** Prints one line. */
  log: (line: string) => void;
  /** Writes a transient status (the thinking and spend ticker), carriage-return terminated. */
  inline?: (text: string) => void;
}

/** The CLI's onEvent: one AgentEvent in, its console lines out. */
export function createEventRenderer(opts: EventRendererOptions): (e: AgentEvent) => void {
  const { totalStages, log } = opts;
  const inline = opts.inline ?? (() => {});
  return (e) => {
    switch (e.type) {
      case 'plan_started':
        log(`\n[1/${totalStages}] Planner …`); break;
      case 'plan_done':
        log(`      ${e.scenarios.length} scenarios planned · $${e.usd.toFixed(4)}`);
        for (const s of e.scenarios) log(`        · [${s.category}] ${s.name}`);
        log(`\n[2/${totalStages}] Explorer …`);
        break;
      case 'thinking_started':
        inline('      · thinking…\r'); break;
      case 'tool_call':
        log(`      → ${e.name}(${trimJson(e.input)})`); break;
      case 'tool_result':
        if (!e.ok) log(`        ✗ ${e.error}`); break;
      case 'message': {
        // Never dropped: printed whole, or cut at the cap with the marker.
        const line = messageLine(e.text);
        if (line !== null) log(`      ${line}`);
        break;
      }
      case 'usage':
        inline(`      $${e.usd.toFixed(4)} · ${e.tokens} tok\r`); break;
      case 'critic_started':
        log(`\n[3/${totalStages}] Critic …`); break;
      case 'critic_done':
        log(`      ${e.verdicts.length} verdicts · $${e.usd.toFixed(4)}`);
        for (const v of e.verdicts) {
          const mark = v.verdict === 'pass' ? '✓' : v.verdict === 'rework' ? '!' : '✗';
          log(`        ${mark} ${v.scenario}: ${v.reasons.join('; ')}`);
        }
        break;
      case 'replay_started':
        log(`\n[4/${totalStages}] Reality check · replaying ${e.total} scenario(s) headlessly …`); break;
      case 'replay_scenario_passed':
        log(`      ✓ ${e.name}  (${e.durationMs}ms)`); break;
      case 'replay_scenario_failed':
        log(`      ✗ ${e.name}  (step ${e.failedStep + 1} ${e.stepKind}: ${truncate(e.error, 120)})`); break;
      case 'replay_scenario_refused':
        log(`      - ${e.name}  (not run: ${e.reason})`); break;
      case 'replay_done':
        log(`      ${e.passed} passed · ${e.failed} dropped${(e.refused ?? 0) > 0 ? ` · ${e.refused} refused by the wrong-password cap` : ''} · ${(e.durationMs / 1000).toFixed(1)}s`); break;
      case 'stability_started': {
        const stage = opts.replay ? 5 : 4;
        log(`\n[${stage}/${totalStages}] Stability · ${e.iterations}× re-run on ${e.total} survivor(s) …`);
        break;
      }
      case 'stability_iteration_passed':
        log(`      ✓ ${e.name}  iter ${e.iteration}  (${e.durationMs}ms)`); break;
      case 'stability_iteration_failed':
        log(`      ✗ ${e.name}  iter ${e.iteration} (step ${e.failedStep + 1} ${e.stepKind}: ${truncate(e.error, 120)})`); break;
      case 'stability_scenario_refused':
        log(`      - ${e.name}  (not run: ${e.reason})`); break;
      case 'stability_done': {
        const recovered = e.recovered ?? 0;
        const recoveredChip = recovered > 0 ? ` · ${recovered} recovered by Stabilizer` : '';
        const stabilizerCost = e.stabilizerCostUsd ?? 0;
        const stabilizerCostChip = stabilizerCost > 0 ? ` · stabilizer $${stabilizerCost.toFixed(4)}` : '';
        log(
          `      ${e.stable} stable${recoveredChip} · ${e.flaked} flaked · flake_rate=${(e.flakeRate * 100).toFixed(1)}%${(e.refused ?? 0) > 0 ? ` · ${e.refused} refused by the wrong-password cap` : ''} · ` +
          `${(e.durationMs / 1000).toFixed(1)}s${stabilizerCostChip}`,
        );
        break;
      }
      case 'gate_injection':
        log(`      [gate] ${e.detail} in "${e.scenario}"`); break;
      case 'gate_broken':
        log(`      [gate] BROKEN "${e.scenario}" after ${e.attempts} attempt(s): ${e.reason}`); break;
      case 'heal':
        log(`      ↺ healed: ${e.from} re-resolved to ${e.to} (${e.intent})`); break;
      case 'review_paused':
        log(`\n■ Paused for review.`); break;
      case 'done':
        // This is the Explorer's count. The final emitted (generated) count
        // and the planned = generated + dropped reconciliation print below.
        log(`\n✓ ${e.scenarios} scenario(s) explored`); break;
    }
  };
}

/**
 * The end-of-run summary, read from the FINAL report (after the emitted-spec
 * check): the cost line, the closing Critic paragraph (the final verdicts,
 * invariant 72), replay and stability, the reconciliation, and rule
 * coverage. This is the one place the CLI prints rule coverage: the runtime
 * no longer prints it before the emitted-spec check can change it.
 */
export function runSummaryLines(result: RunReport): string[] {
  const out: string[] = [];
  // The one cost total (invariant 50): costLine names every term it sums.
  out.push(`${costLine(result)} · cache_read=${result.cost.cacheReadTokens}`);
  out.push(`Cascade: ${JSON.stringify(result.cascadeStats)}`);
  if (result.review?.summary) out.push(`\nCritic: ${result.review.summary}`);
  if (result.replay && !result.replay.skipped) {
    const total = result.replay.passed + result.replay.failed;
    const pct = total > 0 ? Math.round((result.replay.passed / total) * 100) : 0;
    out.push(`Reality check: ${result.replay.passed}/${total} passed twice (${pct}%)${refusedNote(result.replay.refused)} · ${(result.replay.durationMs / 1000).toFixed(1)}s`);
  } else if (result.replay?.skipped) {
    out.push('Reality check: skipped (--no-replay)');
  }
  if (result.stability && !result.stability.skipped) {
    const total = result.stability.passed + result.stability.flaked;
    const pct = (result.stability.flakeRate * 100).toFixed(1);
    // Headline uses strict stable (excludes recovered) when reconciliation is
    // present, so a relaxed-rule survivor is never counted as a clean pass.
    const strictStable = result.reconciliation ? result.reconciliation.stable : result.stability.passed;
    const recovered = result.reconciliation?.recovered ?? result.stability.recovered ?? 0;
    const recoveredNote = recovered > 0 ? ` (+${recovered} recovered)` : '';
    out.push(`Stability:     ${strictStable}/${total} stable across ${result.stability.iterations}×${recoveredNote} · flake_rate=${pct}%${refusedNote(result.stability.refused)} · ${(result.stability.durationMs / 1000).toFixed(1)}s`);
  } else if (result.stability?.skipped) {
    out.push('Stability:     skipped (--no-stability)');
  }
  if (result.reconciliation) {
    out.push('');
    out.push(...renderReconciliation(result.reconciliation));
  }
  out.push(...ruleCoverageLines(result));
  return out;
}

/** Rule coverage from the final report, preceded by a blank line; nothing without a map. */
export function ruleCoverageLines(result: Pick<RunReport, 'ruleCoverage'>): string[] {
  return result.ruleCoverage ? ['', ...renderRuleCoverage(result.ruleCoverage)] : [];
}

function trimJson(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
