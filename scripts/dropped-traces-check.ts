/**
 * Offline evidence for droppedTraces and canonical drop names (invariant 69).
 *
 * For every entry in an old report's reconciliation.dropped and
 * reconciliation.emitted_failed it prints:
 *   - the canonical planned name the drop maps to today, read off the
 *     current reconcile() run over the old report (the pipeline's own
 *     function, never a copy), or NO PLANNED MATCH;
 *   - the stage;
 *   - the step count recoverable from that scenario's recording in
 *     events.jsonl, with its line range (and the repair recording's, when
 *     one exists).
 * It ends with a total per run and, for run 6 (44cb3d), the JSON byte size
 * droppedTraces would have added to run-report.json.
 *
 * Read only, $0: it reads run-report.json and events.jsonl of each run
 * directory and writes nothing anywhere. A missing run directory, report,
 * events.jsonl or critic_done event exits non-zero and names the path.
 *
 * Usage: npx tsx scripts/dropped-traces-check.ts [run-dir ...]
 * With no argument it reads runs 5e4394, 51d535 and 44cb3d.
 *
 * Step counts: one step per recording tool call that succeeded (navigate,
 * click, fill, press, select_option, set_checked, set_input_files, wait,
 * stability_wait, capture, assert, assert_compare, wait_for_text), three for
 * assert_freeze (it records capture, stability_wait and assert_compare). The
 * gate's RULE 5 strips an unused capture when the scenario closes, so a
 * count can exceed the trace by the captures nothing read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readEvents, pairCalls, allSegmentsOf, type Segment } from './lib/run-events.js';
import { reconcile } from '../src/agent/reconcile.js';
import { matchPlanned } from '../src/agent/rule-coverage.js';
import type { RunReport } from '../src/agent/trace.js';

const DEFAULT_RUNS = [
  'output/practicesoftwaretesting-com/20260918T163858Z-5e4394',
  'output/practicesoftwaretesting-com/20260924T152355Z-51d535',
  'output/practicesoftwaretesting-com/20261001T122557Z-44cb3d',
];
const SIZE_RUN = '44cb3d';

const ONE_STEP = new Set(['navigate', 'click', 'fill', 'press', 'select_option', 'set_checked', 'set_input_files', 'wait', 'stability_wait', 'capture', 'assert', 'assert_compare', 'wait_for_text']);

function die(message: string): never {
  console.error(`dropped-traces-check: ${message}`);
  process.exit(2);
}

function stepCount(seg: Segment): number {
  let n = 0;
  for (const c of seg.calls) {
    if (!c.ok) continue;
    if (c.name === 'assert_freeze') n += 3;
    else if (ONE_STEP.has(c.name)) n += 1;
  }
  return n;
}

/**
 * The recording a drop's trace would come from. gate: the last recording of
 * the name before the first Critic pass, accepted or not (the gate refused
 * it). critic and repair: the last accepted recording before the first
 * Critic pass. replay, stability and emitted_failed: the last accepted
 * recording anywhere (a repaired scenario replays its repair recording).
 * Names match through the tolerant matcher the pipeline uses.
 */
function segmentFor(segments: Segment[], name: string, stage: string, criticLine: number): Segment | undefined {
  const pool = segments.filter((s) => {
    if (stage === 'gate') return s.beginLine < criticLine;
    if (stage === 'critic' || stage === 'repair') return s.accepted && s.beginLine < criticLine;
    return s.accepted;
  });
  const names = [...new Set(pool.map((s) => s.name))];
  const hit = matchPlanned(names, [name]).get(name);
  if (hit === undefined) return undefined;
  return pool.filter((s) => s.name === hit).at(-1);
}

/** The repair recording of a critic or repair drop: an accepted recording of the same name after the first Critic pass. */
function repairSegmentFor(segments: Segment[], name: string, criticLine: number): Segment | undefined {
  const pool = segments.filter((s) => s.accepted && s.beginLine > criticLine);
  const names = [...new Set(pool.map((s) => s.name))];
  const hit = matchPlanned(names, [name]).get(name);
  return hit === undefined ? undefined : pool.filter((s) => s.name === hit).at(-1);
}

/** Pretty-printed bytes one trace step adds at the depth droppedTraces nests it, measured on this report's own shipped steps. */
function bytesPerStep(report: RunReport): number | null {
  let bytes = 0;
  let steps = 0;
  for (const s of report.scenarios) {
    if (s.steps.length === 0) continue;
    bytes += Buffer.byteLength(JSON.stringify({ a: [{ steps: s.steps }] }, null, 2)) - Buffer.byteLength(JSON.stringify({ a: [{ steps: [] }] }, null, 2));
    steps += s.steps.length;
  }
  return steps > 0 ? bytes / steps : null;
}

const runDirs = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_RUNS;
const root = process.cwd();
let grandDrops = 0;
let grandNoMatch = 0;
let grandNoSegment = 0;
for (const dir of runDirs) {
  const abs = path.resolve(root, dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) die(`run directory not found: ${abs}`);
  const reportPath = path.join(abs, 'run-report.json');
  if (!fs.existsSync(reportPath)) die(`run-report.json not found: ${reportPath}`);
  const eventsPath = path.join(abs, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) die(`events.jsonl not found: ${eventsPath}`);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as RunReport;
  const old = report.reconciliation;
  if (!old) die(`no reconciliation in ${reportPath}`);
  const events = readEvents(eventsPath);
  const critic = events.find((x) => x.e.type === 'critic_done');
  if (!critic) die(`no critic_done event in ${eventsPath}`);
  const segments = allSegmentsOf(pairCalls(events));

  // The current pipeline's reconciliation of the same report: its drops
  // carry the canonical names droppedTraces would be filed under.
  const now = reconcile(report, { onDuplicate: () => {}, onUnmatchedName: () => {} });
  const nowEntries = [
    ...now.dropped.map((d) => ({ ...d, stage: d.stage as string })),
    ...(now.emitted_failed ?? []).map((e) => ({ ...e, stage: 'emitted_failed' })),
  ];
  const byRecorded = new Map(nowEntries.map((e) => [e.recordedName ?? e.name, e] as const));

  const runId = path.basename(abs).split('-').at(-1);
  const oldEntries = [
    ...old.dropped.map((d) => ({ name: d.name, stage: d.stage as string })),
    ...(old.emitted_failed ?? []).map((e) => ({ name: e.name, stage: 'emitted_failed' })),
  ];
  console.log(`Run ${runId}: ${path.relative(root, reportPath)}`);
  console.log(`${report.plan?.length ?? 0} planned; ${old.dropped.length} dropped and ${(old.emitted_failed ?? []).length} emitted_failed on the report; first Critic pass at events.jsonl line ${critic.line}.`);
  let noMatch = 0;
  let noSegment = 0;
  let steps = 0;
  let repairSteps = 0;
  const sizeEntries: Array<{ entry: Record<string, unknown>; steps: number }> = [];
  oldEntries.forEach((o, i) => {
    const cur = byRecorded.get(o.name);
    const canonical = cur && !(now.unmatchedDropNames ?? []).includes(o.name) ? cur.name : null;
    if (!canonical) noMatch++;
    const seg = segmentFor(segments, o.name, o.stage, critic.line);
    const rseg = o.stage === 'critic' || o.stage === 'repair' ? repairSegmentFor(segments, o.name, critic.line) : undefined;
    const n = seg ? stepCount(seg) : 0;
    const rn = rseg ? stepCount(rseg) : 0;
    if (!seg) noSegment++;
    steps += n;
    repairSteps += rn;
    const stageNote = cur && cur.stage !== o.stage ? ` (the current reconcile files it at ${cur.stage})` : '';
    console.log(`${i + 1}. [${o.stage}]${stageNote} ${JSON.stringify(o.name)}`);
    console.log(`   planned name: ${canonical === null ? (cur ? 'NO PLANNED MATCH' : 'NO PLANNED MATCH (the current reconcile does not list this drop)') : canonical === o.name ? `${JSON.stringify(canonical)} (same as recorded)` : JSON.stringify(canonical)}`);
    console.log(`   steps: ${seg ? `${n} recoverable from events.jsonl lines ${seg.beginLine} to ${seg.endLine}${seg.accepted ? '' : ' (not accepted)'}` : 'NO RECORDING FOUND in events.jsonl'}${rseg ? `; repair recording ${rn} steps, lines ${rseg.beginLine} to ${rseg.endLine}` : ''}`);
    const plannedEntry = (report.plan ?? []).find((p) => p.name === (canonical ?? o.name));
    sizeEntries.push({
      entry: {
        name: canonical ?? o.name,
        ...(canonical && canonical !== o.name ? { recordedName: o.name } : {}),
        stage: cur?.stage ?? o.stage,
        reason: cur?.reason ?? '',
        ...(seg ? { category: seg.category } : {}),
        ...(seg?.feature ? { feature: seg.feature } : {}),
        ...(plannedEntry?.pageUrl ? { pageUrl: plannedEntry.pageUrl } : {}),
        steps: [],
        ...(rseg ? { repairSteps: [] } : {}),
      },
      steps: n + rn,
    });
  });
  grandDrops += oldEntries.length;
  grandNoMatch += noMatch;
  grandNoSegment += noSegment;
  console.log(`Total ${runId}: ${oldEntries.length} drop(s), ${oldEntries.length - noMatch} mapped to a planned name, ${noMatch} with NO PLANNED MATCH, ${noSegment} with no recording found; ${steps} step(s) recoverable, plus ${repairSteps} in repair recordings.`);

  if (runId === SIZE_RUN) {
    const per = bytesPerStep(report);
    if (per === null) die(`no shipped steps in ${reportPath} to measure a step's size on`);
    const base = Buffer.byteLength(JSON.stringify(report, null, 2));
    const headers = Buffer.byteLength(JSON.stringify({ ...report, droppedTraces: sizeEntries.map((x) => x.entry) }, null, 2)) - base;
    const stepBytes = sizeEntries.reduce((sum, x) => sum + x.steps, 0) * per;
    const added = Math.round(headers + stepBytes);
    console.log(`Size ${runId}: run-report.json is ${base} bytes; droppedTraces would add about ${added} bytes (${(100 * added / base).toFixed(1)} percent): ${headers} bytes of entry fields measured exactly, plus ${sizeEntries.reduce((s, x) => s + x.steps, 0)} step(s) at ${per.toFixed(0)} bytes each, the mean pretty-printed size of this report's own shipped steps at the same depth.`);
  }
  console.log('');
}
console.log(`All runs: ${grandDrops} drop(s), ${grandDrops - grandNoMatch} mapped to a planned name, ${grandNoMatch} with NO PLANNED MATCH, ${grandNoSegment} with no recording found.`);
