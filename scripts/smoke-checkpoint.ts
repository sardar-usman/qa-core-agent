/**
 * Locks checkpoint/resume (src/agent/checkpoint.ts + the runAgentLoop hook):
 *   - atomic write (temp + rename, no temp file left behind), overwrite works
 *   - loadCheckpoint validates version and shape with plain-English errors
 *   - per-scenario updates: the loop hook fires once per completed scenario
 *   - deletion on success, retention on abnormal end
 *   - the full resume shape: run to scenario 2 of 4, stop on a billing error,
 *     resume from the checkpoint, finish scenarios 3 and 4, and the union +
 *     carried spend come out right
 *
 * Fake-client pattern from smoke-cost-ceiling: no network, no LLM, no browser.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHECKPOINT_VERSION,
  checkpointPath,
  deleteCheckpoint,
  loadCheckpoint,
  priorSpend,
  remainingPlan,
  resumeHintForRun,
  stopMessage,
  writeCheckpoint,
  type Checkpoint,
} from '../src/agent/checkpoint.js';
import { splitCarriedVerdicts, type ScenarioVerdict } from '../src/agent/critic.js';
import { runAgentLoop } from '../src/agent/runtime.js';
import { createContext } from '../src/agent/tools.js';
import type { Scenario } from '../src/agent/trace.js';
import type { PlannedScenario } from '../src/agent/planner.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { Page } from 'playwright';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-checkpoint-'));
const stubPage = { on: () => {}, off: () => {} } as unknown as Page;
const done = (name: string): Scenario => ({ name, category: 'happy', steps: [] } as unknown as Scenario);
const PLAN: PlannedScenario[] = [
  { name: 'logged in with valid credentials', category: 'happy', rationale: 'r' },
  { name: 'rejected a wrong password', category: 'negative', rationale: 'r' },
  { name: 'rejected an empty username', category: 'negative', rationale: 'r' },
  { name: 'locked out after repeated failures', category: 'edge', rationale: 'r' },
];
const baseCp = (over: Partial<Checkpoint>): Checkpoint => ({
  version: CHECKPOINT_VERSION,
  url: 'https://shop.example/',
  flags: { lang: 'ts', pom: true, features: [], discover: false, urls: [] },
  plan: PLAN,
  fillableFields: 3,
  completedScenarios: [],
  spentUsd: { planner: 0.01, explorer: 0, critic: 0, repair: 0 },
  phase: 'planning',
  nextScenarioIndex: 0,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

/* ─── A. atomic write ──────────────────────────────────────────────────────── */
const p1 = writeCheckpoint(dir, baseCp({}));
check('A1. checkpoint written at the canonical path', p1 === checkpointPath(dir) && fs.existsSync(p1));
check('A2. no temp file left behind (write is temp + rename)', !fs.readdirSync(dir).some((f) => f.includes('.tmp')), JSON.stringify(fs.readdirSync(dir)));
writeCheckpoint(dir, baseCp({ completedScenarios: [done(PLAN[0]!.name)], nextScenarioIndex: 1 }));
check('A3. overwrite replaces the previous checkpoint in place', loadCheckpoint(p1).completedScenarios.length === 1);

/* ─── B. load validation ───────────────────────────────────────────────────── */
try { loadCheckpoint(path.join(dir, 'nope.json')); check('B1. missing file throws', false); }
catch (err) { check('B1. missing file throws with the path', (err as Error).message.includes('nope.json')); }
fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
try { loadCheckpoint(path.join(dir, 'bad.json')); check('B2. invalid JSON throws', false); }
catch (err) { check('B2. invalid JSON throws with a reason', /not valid JSON/.test((err as Error).message)); }
fs.writeFileSync(path.join(dir, 'v99.json'), JSON.stringify({ ...baseCp({}), version: 99 }));
try { loadCheckpoint(path.join(dir, 'v99.json')); check('B3. wrong version throws', false); }
catch (err) { check('B3. wrong version throws naming both versions', /version 99/.test((err as Error).message) && /expected 1/.test((err as Error).message)); }

/* ─── C. remainingPlan tolerates renames ───────────────────────────────────── */
const rem = remainingPlan(PLAN, [done('Logged in with the valid credentials!'), done(PLAN[1]!.name)]);
check('C1. completed scenarios (one renamed) are excluded from the remaining plan',
  rem.length === 2 && rem[0]?.name === PLAN[2]!.name && rem[1]?.name === PLAN[3]!.name, JSON.stringify(rem.map((r) => r.name)));

/* ─── D. per-scenario updates through the real loop ────────────────────────── */
const dCtx = createContext(stubPage, 60);
let dCalls = 0;
const dClient = {
  messages: {
    create: async () => {
      dCalls++;
      if (dCalls <= 2) {
        dCtx.scenarios.push(done(PLAN[dCalls - 1]!.name));
        return {
          usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: 'tool_use', id: `d${dCalls}`, name: 'bogus_tool', input: {} }],
          stop_reason: 'tool_use',
        };
      }
      return { usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [], stop_reason: 'end_turn' };
    },
  },
} as unknown as Anthropic;
const hookSnapshots: number[] = [];
await runAgentLoop({
  client: dClient, model: 'claude-opus-4-7', maxUsd: 10,
  price: { in: 5.0, out: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  maxSteps: 60, ctx: dCtx, url: 'https://shop.example/', plan: PLAN,
  onScenarioComplete: () => {
    hookSnapshots.push(dCtx.scenarios.length);
    writeCheckpoint(dir, baseCp({ completedScenarios: [...dCtx.scenarios], phase: 'exploring' }));
  },
});
check('D1. the hook fires once per completed scenario', JSON.stringify(hookSnapshots) === '[1,2]', JSON.stringify(hookSnapshots));
check('D2. the checkpoint on disk carries both completed traces', loadCheckpoint(p1).completedScenarios.length === 2);

/* ─── E. deletion on success, retention on abnormal end ────────────────────── */
deleteCheckpoint(dir);
check('E1. deletion on success removes the file', !fs.existsSync(p1));

/* ─── F. the full resume shape: 2 of 4, billing stop, resume, finish 3+4 ───── */
// First run: completes scenarios 1 and 2, then the API bills out.
const f1Ctx = createContext(stubPage, 60);
let f1Calls = 0;
const f1Client = {
  messages: {
    create: async () => {
      f1Calls++;
      if (f1Calls <= 2) {
        f1Ctx.scenarios.push(done(PLAN[f1Calls - 1]!.name));
        return {
          usage: { input_tokens: 10_000, output_tokens: 20_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: 'tool_use', id: `f${f1Calls}`, name: 'bogus_tool', input: {} }],
          stop_reason: 'tool_use',
        };
      }
      throw Object.assign(new Error('Your credit balance is too low to access the Anthropic API.'), { status: 400 });
    },
  },
} as unknown as Anthropic;
const run1 = await runAgentLoop({
  client: f1Client, model: 'claude-opus-4-7', maxUsd: 10,
  price: { in: 5.0, out: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  maxSteps: 60, ctx: f1Ctx, url: 'https://shop.example/', plan: PLAN,
  onScenarioComplete: (usd) => {
    writeCheckpoint(dir, baseCp({ completedScenarios: [...f1Ctx.scenarios], spentUsd: { planner: 0.01, explorer: usd, critic: 0, repair: 0 }, phase: 'exploring' }));
  },
});
check('F1. the billing stop ends the loop cleanly at 2 of 4', run1.endedReason === 'run_stopped' && f1Ctx.scenarios.length === 2, run1.endedReason);
check('F2. the checkpoint survives the abnormal end', fs.existsSync(p1));

// Resume: restore, continue on the remaining plan, finish.
const cp = loadCheckpoint(p1);
const toGo = remainingPlan(cp.plan, cp.completedScenarios);
check('F3. resume restores 2 completed and 2 remaining', cp.completedScenarios.length === 2 && toGo.length === 2, `${cp.completedScenarios.length}/${toGo.length}`);
const f2Ctx = createContext(stubPage, 60);
let f2Calls = 0;
const f2Client = {
  messages: {
    create: async () => {
      f2Calls++;
      if (f2Calls <= 2) {
        f2Ctx.scenarios.push(done(toGo[f2Calls - 1]!.name));
        return {
          usage: { input_tokens: 10_000, output_tokens: 20_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: 'tool_use', id: `r${f2Calls}`, name: 'bogus_tool', input: {} }],
          stop_reason: 'tool_use',
        };
      }
      return {
        usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', id: 'fin', name: 'finish', input: { summary: 'resumed and completed' } }],
        stop_reason: 'tool_use',
      };
    },
  },
} as unknown as Anthropic;
const run2 = await runAgentLoop({
  client: f2Client, model: 'claude-opus-4-7', maxUsd: 10,
  price: { in: 5.0, out: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  maxSteps: 60, ctx: f2Ctx, url: cp.url, plan: toGo,
});
check('F4. the resumed loop finishes scenarios 3 and 4 and accepts finish()',
  run2.endedReason === 'finished' && f2Ctx.scenarios.length === 2, `${run2.endedReason}/${f2Ctx.scenarios.length}`);
const union = [...cp.completedScenarios, ...f2Ctx.scenarios];
check('F5. the union covers all 4 planned scenarios exactly once',
  union.length === 4 && new Set(union.map((s) => s.name)).size === 4 && union.map((s) => s.name).join('|') === PLAN.map((s) => s.name).join('|'),
  JSON.stringify(union.map((s) => s.name)));
const carried = priorSpend(cp.spentUsd) + run2.cost.usd;
check('F6. spend carries over: prior checkpoint spend + resumed loop cost',
  carried > cp.spentUsd.explorer && carried > run2.cost.usd && Math.abs(carried - (0.01 + cp.spentUsd.explorer + run2.cost.usd)) < 1e-9,
  String(carried));

/* ─── G. the stop message names the resume path ────────────────────────────── */
const msg = stopMessage('billing/credit exhaustion', p1);
check('G1. the stop message carries reason, state note, and the resume command',
  msg.startsWith('Run stopped: billing/credit exhaustion.') && msg.includes('State saved') && msg.includes(`npm run explore -- --resume ${p1}`), msg);

/* ─── H. the resume hint fires on the ceiling path, exactly once, last ─────── */
// The live gap: the ceiling stop wrote the checkpoint but the hint never
// printed (the CLI's 240-char message cap ate the mid-run event). The CLI now
// suppresses mid-run copies and prints resumeHintForRun as the LAST line.
{
  // A real ceiling stop through the real loop, with the checkpoint on disk.
  const hCtx = createContext(stubPage, 40);
  hCtx.scenarios.push(done(PLAN[0]!.name));
  const hClient = {
    messages: {
      create: async () => ({
        usage: { input_tokens: 100_000, output_tokens: 60_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', id: 'h1', name: 'bogus_tool', input: {} }],
        stop_reason: 'tool_use',
      }),
    },
  } as unknown as Anthropic;
  const hRun = await runAgentLoop({
    client: hClient, model: 'claude-opus-4-7', maxUsd: 1,
    price: { in: 5.0, out: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    maxSteps: 40, ctx: hCtx, url: 'https://shop.example/', plan: [],
  });
  writeCheckpoint(dir, baseCp({ completedScenarios: [...hCtx.scenarios], phase: 'explored' }));
  check('H1. the loop hit the ceiling and the checkpoint is on disk',
    hRun.endedReason === 'cost_ceiling' && fs.existsSync(p1));
  const ceilingStop = { kind: 'cost_ceiling', reason: 'cost ceiling hit ($1.6000 against the explorer share); raise QA_CORE_COST_CEILING and resume' };
  const hint = resumeHintForRun({ stopped: ceilingStop, emptyCause: null, checkpointExists: fs.existsSync(p1), cpPath: p1 });
  check('H2. the CEILING stop produces the specced hint line',
    hint === `Run stopped: ${ceilingStop.reason}. State saved. Resume with: npm run explore -- --resume ${p1}`, hint ?? 'null');
  check('H3. billing and api stops produce the same hint shape',
    resumeHintForRun({ stopped: { kind: 'billing', reason: 'billing/credit exhaustion' }, emptyCause: null, checkpointExists: true, cpPath: p1 })?.startsWith('Run stopped: billing/credit exhaustion.') === true);
  check('H4. critic-gated-all and replay-dropped-all empty runs get the hint too',
    resumeHintForRun({ emptyCause: 'critic-gated-all', checkpointExists: true, cpPath: p1 })?.includes('the critic gated every recorded scenario') === true &&
    resumeHintForRun({ emptyCause: 'replay-dropped-all', checkpointExists: true, cpPath: p1 })?.includes('replay/stability dropped every survivor') === true);
  check('H5. no checkpoint on disk means no hint', resumeHintForRun({ stopped: ceilingStop, emptyCause: null, checkpointExists: false, cpPath: p1 }) === null);
  check('H6. planner-none (nothing to resume) means no hint', resumeHintForRun({ emptyCause: 'planner-none', checkpointExists: true, cpPath: p1 }) === null);
  const cli = fs.readFileSync('src/cli/explore.ts', 'utf8');
  check('H7. the CLI suppresses mid-run hint copies (the 240-char cap ate them live)',
    cli.includes(`startsWith('Run stopped:')`));
  check('H8. the CLI prints the hint on BOTH end paths (success tail + empty guard)',
    (cli.match(/resumeHintForRun\(/g) ?? []).length >= 2);
}

/* ─── I. carried verdicts: a resume never re-bills the critic ──────────────── */
{
  const v = (scenario: string, verdict: ScenarioVerdict['verdict']): ScenarioVerdict =>
    ({ scenario, verdict, reasons: ['r'], required_fixes: [] });
  const carried = [
    v(`[happy] ${PLAN[0]!.name}`, 'pass'),      // prefixed echo still matches
    v(PLAN[1]!.name, 'rework'),
    v('a scenario that no longer exists', 'pass'), // stale: dropped
  ];
  const cpV = baseCp({ completedScenarios: [done(PLAN[0]!.name), done(PLAN[1]!.name)], verdicts: carried, phase: 'reviewing' });
  writeCheckpoint(dir, cpV);
  const loaded = loadCheckpoint(p1);
  check('I1. verdicts round-trip through the checkpoint', loaded.verdicts?.length === 3);

  const allFour = PLAN.map((s) => ({ name: s.name }));
  const split = splitCarriedVerdicts(allFour, loaded.verdicts ?? []);
  check('I2. scenarios with a carried verdict are NOT re-reviewed',
    split.toReview.length === 2 && split.toReview[0]?.name === PLAN[2]!.name && split.toReview[1]?.name === PLAN[3]!.name,
    JSON.stringify(split.toReview.map((s) => s.name)));
  check('I3. the carried verdicts survive (prefixed echo matched, verdict kept)',
    split.carriedVerdicts.length === 2 && split.carriedVerdicts.some((x) => x.verdict === 'rework'),
    JSON.stringify(split.carriedVerdicts));
  check('I4. a stale verdict for a vanished scenario is dropped',
    !split.carriedVerdicts.some((x) => x.scenario.includes('no longer exists')));
  const allCarried = splitCarriedVerdicts(allFour.slice(0, 2), loaded.verdicts ?? []);
  check('I5. with every scenario carried, nothing is left to review (critic spend $0)',
    allCarried.toReview.length === 0 && allCarried.carriedVerdicts.length === 2);
  const none = splitCarriedVerdicts(allFour, []);
  check('I6. a fresh run (no carried verdicts) reviews everything', none.toReview.length === 4 && none.carriedVerdicts.length === 0);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: checkpoints write atomically per scenario, survive abnormal ends, delete on success, and a resume finishes the remaining plan with carried spend.');
