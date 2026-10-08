/**
 * Dropped traces on the run-report (invariant 69).
 *
 * A dropped scenario used to keep only its name and verdict on the report;
 * its recorded steps lived only in events.jsonl, so a drop could not be
 * diagnosed from the artifact. Every drop point now hands its trace to a
 * TraceStore, and after the reconciliation is built each entry of
 * reconciliation.dropped and reconciliation.emitted_failed gets its trace,
 * under the same canonical name:
 *
 *   gate            the rejected trace
 *   critic          the recorded trace (and the repair attempt's trace when a
 *                   repaired scenario was judged and dropped)
 *   repair          the first-pass trace in steps, the repair attempt's trace
 *                   in repairSteps when one was recorded
 *   replay          the trace that was replayed
 *   stability       the trace that was replayed
 *   emitted_failed  the trace that was transcribed
 *
 * The names in droppedTraces must equal the drop names, one trace each. A
 * mismatch is printed loudly and set on report.droppedTracesWarning; it is
 * never a silent gap. Credential values are redacted before the field is
 * attached, so every copy (memory, the working-directory run-report.json,
 * the zipped copy, the dashboard) carries the redacted steps. No truncation
 * and no cap on steps. Nothing that emits a framework reads the field.
 */
import type { RunReport, Scenario, TraceStep } from './trace.js';
import type { DroppedScenario, Reconciliation } from './reconcile.js';
import { matchPlanned, scenarioNameKey } from './rule-coverage.js';
import { credentialSecrets, redactDroppedTraces, rememberCredentialSecrets } from './datasets.js';

export type DroppedTraceStage = DroppedScenario['stage'] | 'emitted_failed';

export interface DroppedTrace {
  /** The plan's canonical name, the same name reconciliation files the drop under. */
  name: string;
  /** The name the scenario was recorded under, only when it differs from `name`. */
  recordedName?: string;
  stage: DroppedTraceStage;
  reason: string;
  category?: Scenario['category'];
  feature?: string;
  /** The planned page, from the plan entry of `name` (multi-page runs). */
  pageUrl?: string;
  /** The trace the stage dropped (for a repair drop, the first-pass trace). */
  steps: TraceStep[];
  /** The repair attempt's trace, when one was recorded. */
  repairSteps?: TraceStep[];
  /**
   * Why `steps` is empty, when no recorded trace exists for the drop: a
   * rule-derived data case that failed the emitted-spec check has no
   * scenario behind it.
   */
  noTrace?: string;
}

/** What a drop point hands over: the trace and what describes it. */
export interface TraceRecord {
  category?: Scenario['category'];
  feature?: string;
  steps: TraceStep[];
  repairSteps?: TraceStep[];
  noTrace?: string;
}

/** Traces by stage, then by the name they were recorded under. */
export type TraceStore = Map<DroppedTraceStage, Map<string, TraceRecord>>;

export function newTraceStore(): TraceStore {
  return new Map();
}

/** Hand one dropped (or droppable) trace to the store. A later record under the same stage and name replaces the earlier one. */
export function storeTrace(store: TraceStore, stage: DroppedTraceStage, name: string, record: TraceRecord): void {
  let byName = store.get(stage);
  if (!byName) { byName = new Map(); store.set(stage, byName); }
  byName.set(name, record);
}

/**
 * The store for one run, from every drop point the runtime has:
 *   gate       the trace each gate-broken scenario was rejected with
 *   critic     each first-pass recording, with the repair attempt's trace as
 *              repairSteps when the scenario was repaired (a repaired
 *              scenario the second review dropped is a critic drop)
 *   repair     the same first-pass recording, with the repair attempt's
 *              partial trace when one was left (a mid-repair stop, a gate
 *              rejection during repair)
 *   replay     every trace sent to replay
 *   stability  every trace sent to stability
 * Repaired traces and attempts are keyed by the recorded rework name.
 */
export function traceStoreForRun(src: {
  gateBroken: Map<string, Pick<Scenario, 'category' | 'feature' | 'steps'>>;
  recorded: Scenario[];
  repaired: Scenario[];
  repairAttempts: Record<string, TraceStep[]>;
  replayed: Scenario[];
  stabilityInput: Scenario[];
}): TraceStore {
  const store = newTraceStore();
  for (const [name, sc] of src.gateBroken) storeTrace(store, 'gate', name, recordOf(sc));
  const repairedByName = new Map(src.repaired.map((sc) => [sc.name, sc] as const));
  for (const sc of src.recorded) {
    const repaired = repairedByName.get(sc.name)?.steps;
    storeTrace(store, 'critic', sc.name, recordOf(sc, repaired));
    storeTrace(store, 'repair', sc.name, recordOf(sc, repaired ?? src.repairAttempts[sc.name]));
  }
  for (const sc of src.replayed) storeTrace(store, 'replay', sc.name, recordOf(sc));
  for (const sc of src.stabilityInput) storeTrace(store, 'stability', sc.name, recordOf(sc));
  return store;
}

/** A scenario as a trace record. */
export function recordOf(s: Pick<Scenario, 'category' | 'feature' | 'steps'>, repairSteps?: TraceStep[]): TraceRecord {
  return {
    ...(s.category ? { category: s.category } : {}),
    ...(s.feature ? { feature: s.feature } : {}),
    steps: s.steps,
    ...(repairSteps ? { repairSteps } : {}),
  };
}

/**
 * The record for a recorded name at a stage: the exact name, then the same
 * normalized key, then the tolerant matcher (exact key first, containment
 * second), so a verdict echo that lost its punctuation still finds its trace.
 */
function lookup(store: TraceStore, stage: DroppedTraceStage, name: string): TraceRecord | undefined {
  const byName = store.get(stage);
  if (!byName) return undefined;
  const exact = byName.get(name);
  if (exact) return exact;
  const key = scenarioNameKey(name);
  for (const [n, r] of byName) if (scenarioNameKey(n) === key) return r;
  const hit = matchPlanned([...byName.keys()], [name]).get(name);
  return hit !== undefined ? byName.get(hit) : undefined;
}

/** The drops the reconciliation names, in funnel order, with their stage. */
function dropEntries(rec: Reconciliation): Array<{ name: string; recordedName?: string; stage: DroppedTraceStage; reason: string }> {
  return [
    ...rec.dropped.map((d) => ({ name: d.name, ...(d.recordedName ? { recordedName: d.recordedName } : {}), stage: d.stage as DroppedTraceStage, reason: d.reason })),
    ...(rec.emitted_failed ?? []).map((e) => ({ name: e.name, ...(e.recordedName ? { recordedName: e.recordedName } : {}), stage: 'emitted_failed' as const, reason: e.reason })),
  ];
}

/**
 * One trace per drop, under the drop's canonical name. A drop with no trace
 * in the store gets no entry (the identity check names it).
 */
export function buildDroppedTraces(rec: Reconciliation, store: TraceStore, plan: RunReport['plan']): DroppedTrace[] {
  const out: DroppedTrace[] = [];
  for (const d of dropEntries(rec)) {
    const r = lookup(store, d.stage, d.recordedName ?? d.name);
    if (!r) continue;
    const pageUrl = (plan ?? []).find((p) => p.name === d.name)?.pageUrl;
    out.push({
      name: d.name,
      ...(d.recordedName ? { recordedName: d.recordedName } : {}),
      stage: d.stage,
      reason: d.reason,
      ...(r.category ? { category: r.category } : {}),
      ...(r.feature ? { feature: r.feature } : {}),
      ...(pageUrl ? { pageUrl } : {}),
      steps: r.steps,
      ...(r.repairSteps ? { repairSteps: r.repairSteps } : {}),
      ...(r.noTrace ? { noTrace: r.noTrace } : {}),
    });
  }
  return out;
}

/**
 * The identity check: the names in droppedTraces equal the names in
 * reconciliation.dropped plus reconciliation.emitted_failed, one trace
 * each. Returns the names a trace is missing for and the names with a trace
 * but no drop (or a second trace), and the warning text when either is
 * non-empty.
 */
export function droppedTracesIdentity(rec: Reconciliation, traces: DroppedTrace[]): { missing: string[]; extra: string[]; warning?: string } {
  const want = new Map<string, number>();
  for (const d of dropEntries(rec)) want.set(d.name, (want.get(d.name) ?? 0) + 1);
  const have = new Map<string, number>();
  for (const t of traces) have.set(t.name, (have.get(t.name) ?? 0) + 1);
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [n, c] of want) for (let i = (have.get(n) ?? 0); i < c; i++) missing.push(n);
  for (const [n, c] of have) for (let i = (want.get(n) ?? 0); i < c; i++) extra.push(n);
  if (missing.length === 0 && extra.length === 0) return { missing, extra };
  const parts: string[] = [];
  if (missing.length) parts.push(`${missing.length} drop(s) with no trace: ${missing.map((n) => JSON.stringify(n)).join(', ')}`);
  if (extra.length) parts.push(`${extra.length} trace(s) with no drop: ${extra.map((n) => JSON.stringify(n)).join(', ')}`);
  return { missing, extra, warning: `droppedTraces does not match the drops: ${parts.join('; ')}` };
}

/**
 * Attach droppedTraces to the report from its reconciliation and the store:
 * built, redacted (the secret set is read from the RAW traces and remembered
 * on the report object, so a later stage still masks a password this
 * redaction hid), and checked against the drop names. The key is omitted
 * when nothing was dropped; a mismatch prints one loud line through `log`
 * and sets droppedTracesWarning. Mutates and returns the report.
 */
export function attachDroppedTraces(report: RunReport, store: TraceStore, log: (line: string) => void): RunReport {
  delete report.droppedTraces;
  delete report.droppedTracesWarning;
  const rec = report.reconciliation;
  if (!rec) return report;
  if (rec.dropped.length === 0 && (rec.emitted_failed ?? []).length === 0) return report;
  const raw = buildDroppedTraces(rec, store, report.plan);
  // The raw traces (a dropped happy login) plus everything the report object already knows (remembered, scenarios, env).
  const secrets = new Set([...credentialSecrets({ ...report, droppedTraces: raw }), ...credentialSecrets(report)]);
  rememberCredentialSecrets(report, secrets);
  report.droppedTraces = redactDroppedTraces(raw, secrets);
  const identity = droppedTracesIdentity(rec, report.droppedTraces);
  if (identity.warning) {
    report.droppedTracesWarning = identity.warning;
    log(`WARNING: ${identity.warning}`);
  }
  return report;
}

/** A store seeded from a report's existing dropped traces, keyed by the name each was recorded under. */
export function storeFromDroppedTraces(traces: DroppedTrace[] | undefined): TraceStore {
  const store = newTraceStore();
  for (const t of traces ?? []) {
    storeTrace(store, t.stage, t.recordedName ?? t.name, {
      ...(t.category ? { category: t.category } : {}),
      ...(t.feature ? { feature: t.feature } : {}),
      steps: t.steps,
      ...(t.repairSteps ? { repairSteps: t.repairSteps } : {}),
      ...(t.noTrace ? { noTrace: t.noTrace } : {}),
    });
  }
  return store;
}
