/**
 * Offline evidence for the rework-rate fixes: which of the new record-time
 * rules would have refused, rewritten or floored a call the Explorer recorded
 * in a scenario the run's FIRST Critic pass reworked.
 *
 *   Task 1  RULE 7 counter literal (a bare integer asserted as a badge's text)
 *           and RULE 9 (a count capture on a counter): refused at the tool.
 *   Task 2  a well-formed literal email in a negative or edge creation flow:
 *           rewritten to a generated email at the fill.
 *   Task 3  RULE 2: an assertion recorded after an action ships at the
 *           10000 ms floor.
 *
 * A second section per run lists, for every scenario the first Critic pass
 * marked pass, each recorded call Task 1 would now refuse or Task 2 would now
 * rewrite (Task 3 floors are not listed: they only lengthen a timeout), or
 * "none". That is the collateral check: a new rule must not refuse or
 * rewrite a call in a scenario the Critic already accepted.
 *
 * Read only, $0: it reads events.jsonl of each run directory and writes
 * nothing anywhere. Every judgment goes through the exported function the
 * tool or the gate uses (ruleSevenShape, hintRecord, counterLiteralReason,
 * counterCountCaptureReason, fillGenerateKind, creationEmailUnmatchedLine,
 * plannedNameFor, rule2Timeout, adaptiveTimeout), never a copy.
 *
 * Usage: npx tsx scripts/rework-shapes.ts [run-dir ...]
 * With no argument it reads runs 51d535 and 44cb3d. A missing run directory,
 * events.jsonl, first critic_done event, rework verdict or pass verdict exits
 * non-zero and names the path it looked for; it never prints an empty mapping.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readEvents, pairCalls, segmentsOf, type Call, type Segment } from './lib/run-events.js';
import { ruleSevenShape, hintRecord, fillGenerateKind, creationEmailUnmatchedLine, plannedNameFor, deriveIntent, type AssertionInput, type ToolContext } from '../src/agent/tools.js';
import { counterLiteralReason, counterCountCaptureReason, rule2Timeout, isActionStep, ASYNC_TIMEOUT_FLOOR_AFTER_ACTION } from '../src/agent/gate.js';
import { adaptiveTimeout } from '../src/agent/adaptive-timeout.js';
import { assignVerdicts, type ScenarioVerdict } from '../src/agent/critic.js';
import type { Assertion, TraceStep } from '../src/agent/trace.js';

const DEFAULT_RUNS = [
  'output/practicesoftwaretesting-com/20260924T152355Z-51d535',
  'output/practicesoftwaretesting-com/20261001T122557Z-44cb3d',
];

interface Hit { task: 1 | 2 | 3; line: number; text: string }

function die(message: string): never {
  console.error(`rework-shapes: ${message}`);
  process.exit(2);
}

function hintText(input: Record<string, unknown>): string {
  for (const k of ['testid', 'css', 'label', 'role', 'text'] as const) {
    if (typeof input[k] === 'string' && String(input[k]).trim()) return `${k} ${JSON.stringify(input[k])}`;
  }
  return 'no locating hint';
}

/**
 * The timeout the tool recorded on an assertion, the way executeAssertion and
 * wait_for_text record it: the model's own value when it passed one; for
 * wait_for_text the value its result reported; none for a toHaveURL or an
 * exact toHaveCount without one; else the adaptive value of the page time
 * since the last action (successful calls only, the clock runTool keeps).
 */
function recordedTimeout(c: Call, pageMsBefore: number): { value: number | undefined; source: string } {
  if (c.name === 'wait_for_text') {
    const reported = c.preview ? (JSON.parse(c.preview) as { timeout?: number }).timeout : undefined;
    if (typeof reported === 'number') return { value: reported, source: 'the adaptive value wait_for_text reported' };
  }
  const requested = Number(c.input.timeout);
  if (c.name === 'assert' && Number.isFinite(requested) && requested > 0) return { value: Math.round(requested), source: 'the model\'s own value' };
  const type = String(c.input.type ?? '');
  if (type === 'toHaveURL') return { value: undefined, source: 'no timeout passed' };
  if (type === 'toHaveCount' && c.input.atLeast == null && Number(c.input.count ?? 0) !== 0) return { value: undefined, source: 'no timeout passed' };
  const observed = pageMsBefore + c.durationMs;
  return { value: adaptiveTimeout(observed), source: `adaptive, ${observed} ms page time since the action read from events.jsonl` };
}

/**
 * What the new rules do to one recording: the hits, plus the console line the
 * fill tool logs once per scenario when a plan exists and the recorded name
 * claims no planned name (the email then stays literal).
 */
function scenarioHits(seg: Segment, planNames: string[], ctxForPlan: ToolContext): { hits: Hit[]; notes: string[] } {
  const hits: Hit[] = [];
  const notes: string[] = [];
  const recorded = seg.calls.filter((c) => c.ok);
  const hasAction = recorded.some((c) => isActionStep({ kind: c.name as TraceStep['kind'] }));
  const canonical = planNames.length ? plannedNameFor(ctxForPlan, seg.name) : null;
  let actionSeen = false;
  let pageMs = 0;
  let pageUrl = '';
  for (const c of recorded) {
    const isAction = isActionStep({ kind: c.name as TraceStep['kind'] });
    if (c.name === 'navigate' && typeof c.input.url === 'string') pageUrl = c.input.url;

    // Task 1: a counter read as a literal or as an element count.
    if (c.name === 'assert') {
      const shape = ruleSevenShape(c.input as unknown as AssertionInput);
      const r = shape && !(shape instanceof Error) ? counterLiteralReason(shape) : null;
      if (r) hits.push({ task: 1, line: c.line, text: `assert ${String(c.input.type)} ${hintText(c.input)} text ${JSON.stringify(c.input.text)}: refused, RULE 7 ${r}` });
    }
    if (c.name === 'wait_for_text') {
      const { text: _text, timeoutMs: _ms, ...hints } = c.input;
      const record = hintRecord(hints);
      const r = record ? counterLiteralReason({ type: 'toHaveText', target: record, text: String(c.input.text ?? '') }) : null;
      if (r) hits.push({ task: 1, line: c.line, text: `wait_for_text ${hintText(c.input)}: refused, RULE 7 ${r}` });
    }
    if (c.name === 'capture') {
      const source = String(c.input.source ?? '');
      const record = hintRecord(c.input, source === 'count' ? 'elements' : 'element');
      const r = record ? counterCountCaptureReason(record, source) : null;
      if (r) hits.push({ task: 1, line: c.line, text: `capture source ${source} ${hintText(c.input)}: refused, RULE 9 ${r}` });
    }

    // Task 2: a well-formed literal email in a negative or edge creation flow.
    if (c.name === 'fill' && seg.category !== 'happy') {
      const value = String(c.input.value ?? '');
      const { generate, unmatched } = fillGenerateKind(c.input, deriveIntent(c.input as { intent?: string }), { name: seg.name, category: seg.category as never, feature: seg.feature }, canonical, planNames.length > 0, pageUrl, value);
      if (unmatched && notes.length === 0) notes.push(`line ${c.line}: ${creationEmailUnmatchedLine(seg.name)}`);
      if (generate === 'email') hits.push({ task: 2, line: c.line, text: `fill ${hintText(c.input)} value ${JSON.stringify(value)}: rewritten to a generated email (generate "email"), judged on the canonical name ${JSON.stringify(canonical ?? seg.name)}` });
    }

    // Task 3: the RULE 2 floor after an action.
    if (c.name === 'assert' || c.name === 'wait_for_text') {
      const preview = c.name === 'wait_for_text' && c.preview ? JSON.parse(c.preview) as { attribute?: string } : {};
      const type = (c.name === 'wait_for_text' ? (preview.attribute ? 'toHaveAttribute' : 'toHaveText') : String(c.input.type)) as Assertion['type'];
      const rec = recordedTimeout(c, pageMs);
      const t = rule2Timeout(type, rec.value, actionSeen, hasAction);
      if (t && t.timeout === ASYNC_TIMEOUT_FLOOR_AFTER_ACTION) {
        hits.push({ task: 3, line: c.line, text: `${c.name} ${type} ${hintText(c.input)}: recorded ${rec.value ?? 'unset'} (${rec.source}); RULE 2 ${t.detail}` });
      }
    }

    // The page clock (runTool): an action restarts it with its own duration,
    // every other successful call adds its duration.
    pageMs = isAction ? c.durationMs : pageMs + c.durationMs;
    if (isAction) actionSeen = true;
  }
  return { hits, notes };
}

const TASK_LABEL: Record<Hit['task'], string> = {
  1: 'Task 1 (counter read by its text)',
  2: 'Task 2 (generated email in a creation flow)',
  3: 'Task 3 (10000 ms floor after an action)',
};

const runDirs = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_RUNS;
const root = process.cwd();
for (const dir of runDirs) {
  const abs = path.resolve(root, dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) die(`run directory not found: ${abs}`);
  const eventsPath = path.join(abs, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) die(`events.jsonl not found: ${eventsPath}`);
  const events = readEvents(eventsPath);
  const critic = events.find((x) => x.e.type === 'critic_done');
  if (!critic) die(`no critic_done event in ${eventsPath}`);
  const verdicts = (critic.e.verdicts ?? []) as ScenarioVerdict[];
  const rework = verdicts.filter((v) => v.verdict === 'rework');
  if (rework.length === 0) die(`the first critic_done event (line ${critic.line} of ${eventsPath}) holds no rework verdict; nothing to map`);
  const passed = verdicts.filter((v) => v.verdict === 'pass');
  if (passed.length === 0) die(`the first critic_done event (line ${critic.line} of ${eventsPath}) holds no pass verdict; nothing to check for collateral`);
  const plan = events.find((x) => x.e.type === 'plan_done');
  const planNames = plan ? ((plan.e.scenarios ?? []) as Array<{ name: string }>).map((s) => s.name) : [];
  const ctxForPlan = { plannedNames: planNames } as unknown as ToolContext;

  const segments = segmentsOf(pairCalls(events, critic.line));
  // One assignment over every verdict, so a pass and a rework never claim the same recording.
  const byVerdict = assignVerdicts(segments.map((s) => s.name), verdicts);
  const runId = path.basename(abs).split('-').at(-1);
  console.log(`Run ${runId}: ${path.relative(root, eventsPath)}`);
  console.log(`First Critic pass: line ${critic.line}, ${rework.length} rework verdict(s) of ${verdicts.length}.${plan ? '' : ' No plan_done event: canonical names fall back to the recorded names.'}`);
  const tally = { 1: 0, 2: 0, 3: 0, none: 0 };
  rework.forEach((v, i) => {
    const segName = [...byVerdict.entries()].find(([, verdict]) => verdict === v)?.[0];
    const seg = segments.find((s) => s.name === segName);
    if (!seg) {
      console.log(`${i + 1}. "${v.scenario}": no accepted recording before line ${critic.line}`);
      tally.none++;
      return;
    }
    console.log(`${i + 1}. "${v.scenario}" [${seg.category}] (recording lines ${seg.beginLine} to ${seg.endLine})`);
    const { hits, notes } = scenarioHits(seg, planNames, ctxForPlan);
    for (const n of notes) console.log(`   note, ${n}`);
    if (hits.length === 0) {
      console.log('   no new rule applies');
      tally.none++;
      return;
    }
    for (const task of [1, 2, 3] as const) {
      const mine = hits.filter((h) => h.task === task);
      if (mine.length) tally[task]++;
      for (const h of mine) console.log(`   ${TASK_LABEL[task]}, line ${h.line}: ${h.text}`);
    }
  });
  console.log(`Summary ${runId}: Task 1 applies to ${tally[1]} scenario(s), Task 2 to ${tally[2]}, Task 3 to ${tally[3]}; no new rule applies to ${tally.none}.`);

  // Collateral: what Task 1 refuses or Task 2 rewrites in a scenario the
  // first Critic pass accepted. Task 3 floors only lengthen a timeout.
  console.log(`Passed scenarios: new refusals or rewrites (${passed.length} pass verdict(s))`);
  let collateral = 0;
  passed.forEach((v, i) => {
    const segName = [...byVerdict.entries()].find(([, verdict]) => verdict === v)?.[0];
    const seg = segments.find((s) => s.name === segName);
    if (!seg) {
      console.log(`${i + 1}. "${v.scenario}": no accepted recording before line ${critic.line}`);
      return;
    }
    const { hits, notes } = scenarioHits(seg, planNames, ctxForPlan);
    const mine = hits.filter((h) => h.task === 1 || h.task === 2);
    console.log(`${i + 1}. "${v.scenario}" [${seg.category}] (recording lines ${seg.beginLine} to ${seg.endLine}): ${mine.length ? `${mine.length} call(s)` : 'none'}`);
    for (const n of notes) console.log(`   note, ${n}`);
    for (const h of mine) console.log(`   ${TASK_LABEL[h.task]}, line ${h.line}: ${h.text}`);
    if (mine.length) collateral++;
  });
  console.log(`Collateral ${runId}: ${collateral ? `${collateral} passed scenario(s) with a new refusal or rewrite` : 'none'}.`);
  console.log('');
}
