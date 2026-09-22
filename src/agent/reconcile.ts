import type { RunReport } from './trace.js';
import { scenarioNameKey } from './rule-coverage.js';

/**
 * Reporting reconciliation.
 *
 * Every scenario the Planner planned must end up generated (shipped in the
 * emitted spec), dropped, incomplete, or a finding, each with a named reason.
 * Nothing vanishes silently.
 *
 *   planned === generated + dropped + incomplete + findings
 *
 * "incomplete" is a scenario the Explorer began but never finalized — usually
 * because the step budget ran out mid-scenario. It is neither shipped nor
 * dropped-by-a-stage; it never reached Replay. It is reported on its own line
 * so the funnel stays honest instead of looking like an unexplained shortfall.
 *
 * "findings" are scenarios where the expected outcome never occurred: the
 * Explorer asserted a success signal the page never produced and, after the
 * retry cap, recorded what actually happened. A finding is a real result (the
 * test would fail), so it is reported on its own line, never shipped green.
 *
 * Drops happen at four stages, in pipeline order:
 *   - gate      — RULE 1/3/4 violation, scenario rejected before Reality-Check
 *   - critic    — verdict rework/reject, not sent to Reality-Check
 *   - replay    — failed the single fresh-context re-run
 *   - stability — flaky or broken across the N iterations (broken includes the
 *                 scenarios the Stabilizer attempted and gave up on)
 *
 * The "stable" headline counts only scenarios that passed every iteration with
 * NO relaxed rule. Scenarios that needed the Stabilizer to pass (recovered) ship
 * but are reported separately, so a relaxed-rule survivor is never sold as a
 * clean pass.
 */

export interface DroppedScenario {
  name: string;
  stage: 'gate' | 'critic' | 'replay' | 'stability';
  reason: string;
}

export interface IncompleteScenario {
  name: string;
  reason: string;
}

export interface FindingScenario {
  name: string;
  /** What the scenario expected to observe (the assumed success signal). */
  expected: string;
  /** Where the page actually stayed. */
  url: string;
  /** Any visible alert / validation / status text at the time. */
  messages: string[];
}

export interface Reconciliation {
  /** Scenarios the Planner planned. Falls back to accountedFor when no plan. */
  planned: number;
  /** Scenarios in the emitted spec (stable + recovered). */
  generated: number;
  /** Every scenario that fell out, each named with stage and reason. */
  dropped: DroppedScenario[];
  /** Scenarios begun but never finalized (e.g. step budget exhausted), each named. */
  incomplete: IncompleteScenario[];
  /** Scenarios whose expected outcome never occurred, each with the real page state. */
  findings: FindingScenario[];
  /** Planned scenarios the Explorer explicitly skipped via skip_scenario, with reasons. */
  skipped: Array<{ name: string; reason: string }>;
  /** generated + dropped.length + incomplete.length + findings.length + skipped.length. */
  accountedFor: number;
  /**
   * Scenarios the Explorer produced beyond the plan (accountedFor - planned,
   * floored at 0). The Explorer is allowed to add coverage — e.g. an a11y check
   * it found worth doing. These are still fully named in generated/dropped, so
   * they do not break the balance; they are reported as "+N added".
   */
  added: number;
  /**
   * True when nothing vanished unaccounted: accountedFor >= planned. A surplus
   * (Explorer added scenarios) still balances. Only a shortfall — fewer
   * scenarios accounted for than planned, with no incomplete reason for the gap
   * — is a real MISMATCH.
   */
  balanced: boolean;
  /** Shipped AND passed every iteration with no relaxed rule. Excludes recovered. */
  stable: number;
  /** Shipped only after a Stabilizer relaxed-rule fix. */
  recovered: number;
  /** Dropped flaky (passed then failed, not recovered, not a give-up). */
  flaky: number;
  /** Dropped broken, including scenarios the Stabilizer gave up on. */
  broken: number;
  /** True when no Planner plan was recorded and planned fell back to the total. */
  noPlan?: boolean;
  /** Explains the delta when planned !== accountedFor. */
  note?: string;
}

export interface ReconcileOptions {
  /**
   * A name found in more than one bucket (a finding and a skip, a drop and a
   * skip). Without a handler the builder THROWS, so a smoke fixture with a
   * double record fails loudly; the runtime passes a handler that prints a
   * warning line and the builder then counts the name once, in the earliest
   * bucket, never as "+N added".
   */
  onDuplicate?: (message: string) => void;
}

/** Build the reconciliation purely from a finished RunReport. */
export function reconcile(report: RunReport, opts: ReconcileOptions = {}): Reconciliation {
  const generated = report.scenarios.length;
  const dropped: DroppedScenario[] = [];

  // 1. Gate — rejected before Reality-Check.
  for (const b of report.gate?.broken ?? []) {
    dropped.push({
      name: b.scenario,
      stage: 'gate',
      reason: `gate: ${b.reason} (after ${b.attempts} attempt${b.attempts === 1 ? '' : 's'})`,
    });
  }

  // 2. Critic: rework/reject verdicts are not sent to Reality-Check. A
  // rework the reserve did not fund names that cause first, so the funnel
  // and the coverage report say why the scenario was never repaired.
  const notRepaired = new Map<string, string>();
  for (const h of report.review?.repair ?? []) if (h.notRepaired) notRepaired.set(scenarioNameKey(h.scenario), h.notRepaired);
  for (const v of report.review?.verdicts ?? []) {
    if (v.verdict === 'pass') continue;
    const why = v.reasons.length > 0 ? `: ${v.reasons.join('; ')}` : '';
    const cause = v.verdict === 'rework' ? notRepaired.get(scenarioNameKey(v.scenario)) : undefined;
    dropped.push({ name: v.scenario, stage: 'critic', reason: cause ? `rework, not repaired: ${cause}${why}` : `critic ${v.verdict}${why}` });
  }

  // 3. Replay — failed the single fresh-context re-run.
  if (report.replay && !report.replay.skipped) {
    for (const v of report.replay.verdicts) {
      if (v.passed) continue;
      const at = v.failedStep != null ? ` at step ${v.failedStep + 1}` : '';
      const kind = v.stepKind ? ` (${v.stepKind})` : '';
      dropped.push({
        name: v.name,
        stage: 'replay',
        reason: `replay failed${at}${kind}: ${v.error ?? 'unknown error'}`,
      });
    }
  }

  // 4. Stability — flaky or broken across the iterations.
  let stable = generated;
  let recovered = 0;
  let flaky = 0;
  let broken = 0;
  if (report.stability && !report.stability.skipped) {
    stable = 0;
    for (const v of report.stability.verdicts) {
      if (v.classification === 'stable') {
        if (v.relaxed) recovered++;
        else stable++;
        continue;
      }
      if (v.classification === 'broken') {
        broken++;
        const how = v.gaveUp ? 'Stabilizer gave up' : 'every iteration failed';
        dropped.push({
          name: v.name,
          stage: 'stability',
          reason: `broken — ${how} (pattern ${v.pattern})`,
        });
      } else {
        flaky++;
        dropped.push({
          name: v.name,
          stage: 'stability',
          reason: `flaky — passed then failed (pattern ${v.pattern})`,
        });
      }
    }
  }

  // 5. Incomplete — begun but never finalized (step budget exhausted, etc.).
  const incomplete: IncompleteScenario[] = (report.incomplete ?? []).map((i) => ({
    name: i.scenario,
    reason: i.reason,
  }));

  // 6. Findings: expected outcome never occurred (retry cap tripped).
  const findings: FindingScenario[] = (report.findings ?? []).map((f) => ({
    name: f.scenario,
    expected: f.expected,
    url: f.url,
    messages: f.messages,
  }));

  // 7. Skipped: the Explorer explicitly declined a planned scenario with a
  // reason (skip_scenario). Its own term, never a silent shortfall. A name is
  // counted ONCE across the terms: the runtime refuses a skip of a scenario
  // already recorded as a finding (and the reverse), and this pass is the
  // guard for a report written before that rule (run 5e4394 counted one
  // scenario as both, and the funnel read "+1 unplanned").
  const skippedAll = (report.skipped ?? []).map((s) => ({ name: s.scenario, reason: s.reason }));
  // One name, one bucket. The buckets in pipeline order: generated, dropped,
  // incomplete, findings, skipped. A name seen again in a later bucket is a
  // double record: reported loudly (thrown without a handler), then counted
  // once in the earliest bucket.
  const seen = new Map<string, string>();
  let doubleCounted = 0;
  const doubleNames: string[] = [];
  const claim = (bucket: string, name: string): boolean => {
    const key = scenarioNameKey(name);
    const first = seen.get(key);
    if (first !== undefined) {
      const msg = `reconciliation: "${name}" is recorded as both ${first} and ${bucket}; a scenario belongs to one bucket (counted once, as ${first})`;
      if (!opts.onDuplicate) throw new Error(msg);
      opts.onDuplicate(msg);
      doubleCounted++;
      doubleNames.push(`"${name}" (${first} and ${bucket})`);
      return false;
    }
    seen.set(key, bucket);
    return true;
  };
  for (const s of report.scenarios) claim('generated', s.name);
  const droppedOnce = dropped.filter((d) => claim(`dropped at ${d.stage}`, d.name));
  dropped.length = 0;
  dropped.push(...droppedOnce);
  const incompleteOnce = incomplete.filter((i) => claim('incomplete', i.name));
  incomplete.length = 0;
  incomplete.push(...incompleteOnce);
  const findingsOnce = findings.filter((f) => claim('a finding', f.name));
  findings.length = 0;
  findings.push(...findingsOnce);
  const skipped = skippedAll.filter((s) => claim('skipped', s.name));

  const accountedFor = generated + dropped.length + incomplete.length + findings.length + skipped.length;
  const planned = report.plan?.length ?? accountedFor;
  const noPlan = report.plan == null;
  const added = Math.max(0, accountedFor - planned);
  const shortfall = planned - accountedFor;
  // A surplus is fine — the Explorer added coverage and every extra scenario is
  // named in generated/dropped. Only a shortfall (scenarios unaccounted for) is
  // a real mismatch.
  const balanced = shortfall <= 0;
  let note: string | undefined;
  if (noPlan) {
    note = 'no Planner plan recorded — reconciled against the pipeline total';
  } else if (doubleCounted > 0) {
    // The names live on the artifact, not only on the console warning line.
    note = `${doubleCounted} scenario(s) recorded in two buckets, counted once in the earliest: ${doubleNames.join('; ')}.`;
  } else if (added > 0) {
    note = `Explorer added ${added} scenario(s) beyond the ${planned} planned (e.g. an a11y check). All ${accountedFor} are named below, so the run still balances.`;
  } else if (shortfall > 0) {
    note = `Explorer accounted for ${accountedFor} scenario(s) vs ${planned} planned (${shortfall} fewer). ${shortfall} planned scenario(s) vanished without a drop or incomplete reason.`;
  }

  return { planned, generated, dropped, incomplete, findings, skipped, accountedFor, added, balanced, stable, recovered, flaky, broken, noPlan, note };
}

/** Which stage of the pipeline left a zero-scenario run empty. */
export type EmptyRunCause = 'planner-none' | 'explorer-none' | 'critic-gated-all' | 'replay-dropped-all';

/**
 * Cause-specific diagnosis for a run that produced zero scenarios. The old
 * behavior printed "the Planner couldn't reach the URL" for every empty run,
 * which was wrong and expensive to believe (a $4.19 live run had 20 planned,
 * 6 recorded, and all 6 gated by the critic). The report knows exactly where
 * the funnel emptied; say that, with counts, and for a critic wipe-out the
 * verdict summary. Returns null when the run is not empty.
 */
export function diagnoseEmptyRun(report: RunReport): { cause: EmptyRunCause; lines: string[] } | null {
  if (report.scenarios.length > 0) return null;
  const rec = report.reconciliation ?? reconcile(report);
  const planned = report.plan?.length ?? 0;
  const gateDrops = rec.dropped.filter((d) => d.stage === 'gate');
  const criticDrops = rec.dropped.filter((d) => d.stage === 'critic');
  const replayDrops = rec.dropped.filter((d) => d.stage === 'replay');
  const stabilityDrops = rec.dropped.filter((d) => d.stage === 'stability');
  // Scenarios that made it OUT of the Explorer (the critic saw them).
  const recorded = criticDrops.length + replayDrops.length + stabilityDrops.length;

  if (planned === 0) {
    return {
      cause: 'planner-none',
      lines: ['The Planner planned 0 scenarios, so nothing was explored. The page may not have rendered its content, or it has nothing testable.'],
    };
  }
  if (recorded === 0) {
    const lines = [
      `The Explorer recorded 0 of ${planned} planned scenario(s).`,
    ];
    if (gateDrops.length > 0) lines.push(`  ${gateDrops.length} broke at the gate: ${gateDrops.map((d) => `"${d.name}" (${d.reason})`).join('; ')}`);
    if (rec.findings.length > 0) lines.push(`  ${rec.findings.length} became finding(s): the expected outcome never occurred (see the findings above).`);
    if (rec.incomplete.length > 0) lines.push(`  ${rec.incomplete.length} left incomplete: ${rec.incomplete.map((i) => `"${i.name}" (${i.reason})`).join('; ')}`);
    if (rec.skipped.length > 0) lines.push(`  ${rec.skipped.length} skipped by the Explorer: ${rec.skipped.map((s) => `"${s.name}" (${s.reason})`).join('; ')}`);
    lines.push('The page was reached; the failure happened during exploration, not planning.');
    return { cause: 'explorer-none', lines };
  }
  if (criticDrops.length === recorded) {
    const lines = [
      `The Explorer recorded ${recorded} scenario(s); the Critic gated ALL of them (nothing reached Reality-Check).`,
      'Verdicts:',
    ];
    for (const v of report.review?.verdicts ?? []) {
      if (v.verdict === 'pass') continue;
      lines.push(`  • "${v.scenario}": ${v.verdict}${v.reasons.length ? ` — ${v.reasons.join('; ')}` : ''}`);
    }
    return { cause: 'critic-gated-all', lines };
  }
  const survivedCritic = recorded - criticDrops.length;
  const lines = [
    `The Explorer recorded ${recorded} scenario(s), ${survivedCritic} passed the Critic, and replay/stability dropped every survivor ` +
      `(${replayDrops.length} at replay, ${stabilityDrops.length} at stability).`,
  ];
  for (const d of [...replayDrops, ...stabilityDrops]) {
    lines.push(`  • "${d.name}" — ${d.reason}`);
  }
  return { cause: 'replay-dropped-all', lines };
}

/**
 * Render the reconciliation as plain text lines for the CLI and gateway.
 * Names every dropped scenario and its reason.
 */
export function renderReconciliation(rec: Reconciliation): string[] {
  const lines: string[] = [];
  const balanceMark = rec.balanced ? 'OK' : 'MISMATCH';
  // Only show the incomplete term when there is something incomplete, so clean
  // runs keep the familiar "generated + dropped" line.
  const incompleteTerm = rec.incomplete.length > 0 ? ` + incomplete ${rec.incomplete.length}` : '';
  const findingsTerm = rec.findings.length > 0 ? ` + findings ${rec.findings.length}` : '';
  const skippedTerm = rec.skipped.length > 0 ? ` + skipped ${rec.skipped.length}` : '';
  // When the Explorer added scenarios beyond the plan, annotate the planned term
  // so the surplus is visible and the [OK] mark is not surprising.
  const plannedTerm = rec.added > 0 ? `planned ${rec.planned} (+${rec.added} added)` : `planned ${rec.planned}`;
  lines.push(
    `Reconciliation: ${plannedTerm} = generated ${rec.generated} + dropped ${rec.dropped.length}${incompleteTerm}${findingsTerm}${skippedTerm} [${balanceMark}]`,
  );
  lines.push(
    `  stable ${rec.stable} · recovered ${rec.recovered} · flaky ${rec.flaky} · broken ${rec.broken}` +
      (rec.recovered > 0 ? '   (stable excludes recovered — relaxed-rule survivors)' : ''),
  );
  if (rec.dropped.length > 0) {
    lines.push('  dropped:');
    for (const d of rec.dropped) {
      lines.push(`    • [${d.stage}] "${d.name}" — ${d.reason}`);
    }
  }
  if (rec.incomplete.length > 0) {
    lines.push('  incomplete:');
    for (const i of rec.incomplete) {
      lines.push(`    • "${i.name}" — ${i.reason}`);
    }
  }
  if (rec.findings.length > 0) {
    lines.push('  findings (expected outcome did not occur):');
    for (const f of rec.findings) {
      const msg = f.messages.length > 0 ? ` Page said: ${f.messages.join(' | ')}.` : ' No visible message.';
      lines.push(`    • "${f.name}" — expected ${f.expected}, page stayed at ${f.url}.${msg}`);
    }
  }
  if (rec.skipped.length > 0) {
    lines.push('  skipped (declined by the Explorer, with reason):');
    for (const s of rec.skipped) {
      lines.push(`    • "${s.name}" — ${s.reason}`);
    }
  }
  if (rec.note) lines.push(`  note: ${rec.note}`);
  return lines;
}
