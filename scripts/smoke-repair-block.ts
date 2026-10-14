/**
 * smoke-repair-block: the whole repair block, driven through explore() with
 * a fixture Explorer (a scripted model client) and a fixture Critic (the
 * ExploreOptions.critique seam), then the emitted-spec check, on a local
 * site. $0, no model call (invariant 72; the seam was unreachable from the
 * pipeline until now, so only repairOutcome was locked).
 *
 * The run: three planned scenarios citing R1, R2 and R3.
 *   - "showed the shop heading" (R1): first pass rework, the repair
 *     re-records it, the second pass keeps it (its required fix applied).
 *   - "showed the shop greeting" (R2): first pass rework, the repair
 *     re-records it, the second pass drops it (its required fix not applied).
 *   - "showed the shop footer" (R3): first pass pass, replays green, then
 *     the site loses its footer and the emitted-spec check drops it.
 *
 * Asserted: review.repair (both journeys, firstReasons kept on the entry),
 * the reconciliation (balanced, the critic and emitted_failed drops), the
 * repair decision line printed whole by the CLI renderer, the closing Critic
 * paragraph from the final verdicts with no first-pass complaint in it, and
 * exactly one "Rule coverage:" line on the console, with the post-check
 * number. A second run whose repair loop overspends its own budget prints
 * "Repair budget reached ($X.XX of $Y.YY)", never "Cost ceiling reached".
 *
 *   npx tsx scripts/smoke-repair-block.ts
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { explore, type AgentEvent, type ReviewPaused } from '../src/agent/runtime.js';
import type { critique as realCritique, CriticResult, ScenarioVerdict } from '../src/agent/critic.js';
import { scaffold } from '../src/agent/scaffold.js';
import { emittedCheckStage } from '../src/agent/emitted-check.js';
import { createEventRenderer, runSummaryLines } from '../src/cli/render.js';
import type { PlannedScenario } from '../src/agent/planner.js';
import type { RequirementsMap } from '../src/agent/requirements.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

// No real account and no real key reach this run: every model call goes to a seam.
for (const k of Object.keys(process.env)) if (k.startsWith('QA_CORE_TEST_')) delete process.env[k];
process.env.ANTHROPIC_API_KEY ??= 'fixture-key-never-sent';

/* ─── the fixture site ─────────────────────────────────────────────────────── */
let footerGone = false;
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html lang="en"><head><title>Shop</title></head><body><main>
<h1>Shop</h1><p id="greeting">Welcome to the shop</p>
${footerGone ? '' : '<footer id="site-footer">Shop footer</footer>'}
</main></body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

const HEADING = 'showed the shop heading';
const GREETING = 'showed the shop greeting';
const FOOTER = 'showed the shop footer';
const plan: PlannedScenario[] = [
  { name: HEADING, category: 'happy', rationale: 'r', feature: 'shop', ruleIds: ['R1'] },
  { name: GREETING, category: 'happy', rationale: 'r', feature: 'shop', ruleIds: ['R2'] },
  { name: FOOTER, category: 'happy', rationale: 'r', feature: 'shop', ruleIds: ['R3'] },
];
const requirements = {
  features: [{
    name: 'shop', description: 'the shop page',
    rules: [
      { id: 'R1', text: 'The shop page shows its heading.', type: 'behavior' },
      { id: 'R2', text: 'The shop page greets the visitor.', type: 'behavior' },
      { id: 'R3', text: 'The shop page shows its footer.', type: 'behavior' },
    ],
  }],
  roles: [],
} as unknown as RequirementsMap;

/* ─── the fixture Explorer: one scripted tool call per model response ──────── */
type Call = { name: string; input: Record<string, unknown> };
const record = (name: string, css: string, intent: string): Call[] => [
  { name: 'begin_scenario', input: { name, category: 'happy', feature: 'shop' } },
  { name: 'navigate', input: { url: siteUrl } },
  { name: 'assert', input: { type: 'toBeVisible', css, intent, timeout: 10000 } },
  { name: 'end_scenario', input: {} },
];
function scriptedClient(script: Call[], usage: { input: number; output: number }): { client: Anthropic; calls: () => number } {
  let n = 0;
  const client = {
    messages: {
      create: async () => {
        const call = script[n];
        n++;
        const u = { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        if (!call) return { usage: u, content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
        return { usage: u, content: [{ type: 'tool_use', id: `tu${n}`, name: call.name, input: call.input }], stop_reason: 'tool_use' };
      },
    },
  } as unknown as Anthropic;
  return { client, calls: () => n };
}

/* ─── the fixture Critic: the first review, then the repair review ─────────── */
const FIRST_COMPLAINT_HEADING = 'first-pass complaint: the heading check is a bare visibility probe';
const FIRST_COMPLAINT_GREETING = 'first-pass complaint: the greeting check never reads the greeting text';
const FIRST_SUMMARY = `The first pass found weak checks: ${FIRST_COMPLAINT_HEADING}; ${FIRST_COMPLAINT_GREETING}.`;
const FIX_HEADING = 'assert the heading text, not only its visibility';
const FIX_GREETING = 'assert the greeting text';
let criticCalls = 0;
const critiqueCalls: Array<{ names: string[]; repair: boolean }> = [];
const fixtureCritic: typeof realCritique = async (opts) => {
  criticCalls++;
  const names = opts.scenarios.map((s) => s.name);
  critiqueCalls.push({ names, repair: !!opts.repairFixes });
  const v = (scenario: string, verdict: ScenarioVerdict['verdict'], reasons: string[], extra: Partial<ScenarioVerdict> = {}): ScenarioVerdict =>
    ({ scenario, verdict, reasons, required_fixes: [], ...extra });
  const result = (verdicts: ScenarioVerdict[], summary: string): CriticResult => ({ verdicts, summary, costUsd: 0.001, raw: '', unreviewed: [], warnings: [] });
  if (!opts.repairFixes) {
    return result([
      v(HEADING, 'rework', [FIRST_COMPLAINT_HEADING], { required_fixes: [FIX_HEADING] }),
      v(GREETING, 'rework', [FIRST_COMPLAINT_GREETING], { required_fixes: [FIX_GREETING] }),
      v(FOOTER, 'pass', ['the footer check is sound']),
    ].filter((x) => names.includes(x.scenario)), FIRST_SUMMARY);
  }
  return result([
    v(HEADING, 'pass', ['the repaired heading check is sound'], { fixes: [{ fix: FIX_HEADING, applied: true, reason: 'the re-recorded assert reads the heading' }], observations: [] }),
    v(GREETING, 'rework', ['still a visibility probe'], { fixes: [{ fix: FIX_GREETING, applied: false, reason: 'the re-recorded assert is still toBeVisible' }], observations: [] }),
  ].filter((x) => names.includes(x.scenario)), 'The repair review kept the heading check and dropped the greeting check.');
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-repair-block-'));
const agentCwd = process.cwd();
// The runtime keeps per-host memory under the working directory: keep it out of the repo.
process.chdir(tmpRoot);

async function runOnce(opts: { outDir: string; script: Call[]; usage: { input: number; output: number }; maxUsd: number }): Promise<{ report: RunReport; events: AgentEvent[]; explorerCalls: number }> {
  const events: AgentEvent[] = [];
  const { client, calls } = scriptedClient(opts.script, opts.usage);
  const r = await explore({
    url: siteUrl, language: 'ts', outDir: opts.outDir, fromPlan: plan, requirements,
    model: 'claude-opus-4-7', maxUsd: opts.maxUsd, skipStability: true, stabilize: false, loginPreflightDone: true,
    explorerClient: client, critique: fixtureCritic,
    onEvent: (e) => events.push(e),
  });
  if ((r as ReviewPaused).paused) throw new Error('unexpected pause');
  return { report: r as RunReport, events, explorerCalls: calls() };
}

try {
  /* ─── A. the whole repair block, then the emitted-spec check ────────────── */
  const explorationScript: Call[] = [
    ...record(HEADING, 'h1', 'shop heading'),
    ...record(GREETING, '#greeting', 'shop greeting'),
    ...record(FOOTER, '#site-footer', 'shop footer'),
    { name: 'finish', input: { summary: 'explored all three' } },
  ];
  const repairScript: Call[] = [
    ...record(HEADING, 'h1', 'shop heading'),
    ...record(GREETING, '#greeting', 'shop greeting'),
    { name: 'finish', input: { summary: 'repaired both' } },
  ];
  const outDir = path.join(tmpRoot, 'run-a');
  const { report, events, explorerCalls } = await runOnce({ outDir, script: [...explorationScript, ...repairScript], usage: { input: 1000, output: 100 }, maxUsd: 2 });
  const messages = events.filter((e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message').map((e) => e.text);

  check('A1. the fixture Explorer drove both loops, every scripted call consumed', explorerCalls >= explorationScript.length + repairScript.length, `${explorerCalls} calls; ${messages.slice(-12).join(' | ')}`);
  check('A2. the Critic seam ran the first review and the repair review, and nothing else', criticCalls === 2 && critiqueCalls[0]!.repair === false && critiqueCalls[1]!.repair === true && JSON.stringify(critiqueCalls[1]!.names.sort()) === JSON.stringify([GREETING, HEADING].sort()), JSON.stringify(critiqueCalls));
  const decision = messages.find((m) => m.startsWith('repair pass:'));
  check('A3. the repair decision line was emitted: 2 of 2 funded', !!decision && decision.startsWith('repair pass: 2 of 2 rework scenario(s), budget $'), decision ?? JSON.stringify(messages));

  const repair = report.review?.repair ?? [];
  const h = repair.find((x) => x.scenario === HEADING);
  const g = repair.find((x) => x.scenario === GREETING);
  check('A4. review.repair: the heading journey is rework -> pass, kept, its fix applied', h?.first === 'rework' && h.second === 'pass' && h.outcome === 'kept' && h.fixes?.[0]?.applied === true, JSON.stringify(h));
  check('A5. review.repair: the greeting journey is rework -> rework, dropped, its fix not applied', g?.first === 'rework' && g.second === 'rework' && g.outcome === 'dropped' && g.fixes?.[0]?.applied === false, JSON.stringify(g));
  check('A6. the first-pass reasons stay on review.repair[] only (firstReasons)', JSON.stringify(h?.firstReasons) === JSON.stringify([FIRST_COMPLAINT_HEADING]) && JSON.stringify(g?.firstReasons) === JSON.stringify([FIRST_COMPLAINT_GREETING]), JSON.stringify(repair));
  check('A7. the final verdicts carry no first-pass complaint', !JSON.stringify(report.review?.verdicts).includes('first-pass complaint'), JSON.stringify(report.review?.verdicts));

  const summary = report.review?.summary ?? '';
  console.log(`  before: Critic: ${FIRST_SUMMARY}`);
  console.log(`  after:  Critic: ${summary}`);
  check('A8. the closing Critic paragraph reads the final verdicts and holds no first-pass complaint',
    !summary.includes('first-pass complaint') && summary.startsWith('Final verdicts after the repair pass: 2 pass, 1 rework, 0 reject.')
    && summary.includes(`"${HEADING}" rework -> pass (kept, 1 of 1 required fixes applied)`)
    && summary.includes(`"${GREETING}" rework -> rework (dropped, 0 of 1 required fixes applied): required fix not applied: ${FIX_GREETING}`)
    && summary.endsWith('Repair review: The repair review kept the heading check and dropped the greeting check.'), summary);

  check('A9. before the emitted-spec check: heading and footer shipped, coverage 2 of 3', report.scenarios.map((s) => s.name).sort().join('|') === [FOOTER, HEADING].sort().join('|') && report.ruleCoverage?.covered.length === 2, JSON.stringify({ shipped: report.scenarios.map((s) => s.name), cov: report.ruleCoverage }));
  check('A10. the runtime printed no rule coverage line', !messages.some((m) => m.startsWith('Rule coverage:')), messages.filter((m) => m.startsWith('Rule')).join(' | '));

  // The footer disappears from the site: the emitted spec for it fails twice.
  footerGone = true;
  const frameworkDir = path.join(tmpRoot, 'emit', 'shop-automation-framework');
  const scaffoldOpts = { outDir: frameworkDir, siteName: '127.0.0.1', features: [] as string[], requirements };
  scaffold({ report, ...scaffoldOpts });
  const checkLines: string[] = [];
  process.chdir(agentCwd);
  await emittedCheckStage({
    report, frameworkDir, requirements,
    rescaffold: (r) => { scaffold({ report: r, ...scaffoldOpts }); },
    log: (line) => checkLines.push(line),
  });
  process.chdir(tmpRoot);
  check('A11. the emitted-spec check dropped the footer test', (report.emittedFailed ?? []).some((e) => e.scenario === FOOTER) && !report.scenarios.some((s) => s.name === FOOTER), JSON.stringify({ failed: report.emittedFailed, run: report.emittedRun, lines: checkLines }));

  const rec = report.reconciliation!;
  check('A12. the reconciliation balances: 3 planned, 1 shipped, the greeting a critic drop, the footer emitted_failed',
    rec.balanced === true && rec.planned === 3 && rec.generated === 1
    && rec.dropped.some((d) => d.name === GREETING && d.stage === 'critic')
    && (rec.emitted_failed ?? []).some((d) => d.name === FOOTER), JSON.stringify(rec));

  // The console, as the CLI prints it: the runtime's events through the
  // renderer, the emitted-spec check's lines, then the end-of-run summary.
  const consoleLines: string[] = [];
  const render = createEventRenderer({ totalStages: 4, replay: true, log: (l) => consoleLines.push(...l.split('\n')) });
  for (const e of events) render(e);
  consoleLines.push(...checkLines);
  for (const l of runSummaryLines(report)) consoleLines.push(...l.split('\n'));
  const coverageLines = consoleLines.filter((l) => l.trim().startsWith('Rule coverage:'));
  console.log(`  before: Rule coverage: 2 of 3 rules covered (runtime, before the check) | Rule coverage: 1 of 3 rules covered (CLI, after it)`);
  console.log(`  after:  ${coverageLines.join(' | ')}`);
  check('A13. exactly one "Rule coverage:" line reaches the console, with the post-check number',
    coverageLines.length === 1 && coverageLines[0]!.trim() === 'Rule coverage: 1 of 3 rules covered' && report.ruleCoverage?.covered.length === 1, JSON.stringify(coverageLines));
  check('A14. the report\'s ruleCoverage equals that print', `Rule coverage: ${report.ruleCoverage!.covered.length} of ${report.ruleCoverage!.covered.length + report.ruleCoverage!.uncovered.length} rules covered` === coverageLines[0]!.trim());
  check('A15. the CLI renderer prints the repair decision line whole', consoleLines.some((l) => l.trim() === decision), decision);
  const critic = consoleLines.filter((l) => l.startsWith('Critic: '));
  check('A16. the console\'s closing Critic paragraph is the final one, once', critic.length === 1 && critic[0] === `Critic: ${summary}` && !critic[0].includes('first-pass complaint'), JSON.stringify(critic));

  /* ─── B. a repair loop that overspends its own budget ──────────────────── */
  // Every call costs $0.055 (6000 in, 1000 out at Opus prices). Ceiling $1:
  // the 13 exploration calls spend $0.715, under the $0.85 explorer share;
  // the repair budget is then max($0.15 reserve, $1 minus spend) = about
  // $0.28, which the 9 repair calls overrun after the sixth.
  criticCalls = 0;
  critiqueCalls.length = 0;
  const outB = path.join(tmpRoot, 'run-b');
  const b = await runOnce({ outDir: outB, script: [...explorationScript, ...repairScript], usage: { input: 6_000, output: 1_000 }, maxUsd: 1 });
  const msgsB = b.events.filter((e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message').map((e) => e.text);
  const repairStop = msgsB.find((m) => m.startsWith('Repair budget reached ('));
  console.log(`  before: Cost ceiling reached ($1.547 > $1.5053279999999996); stopping the Explorer and salvaging completed scenarios.`);
  console.log(`  after:  ${repairStop ?? '(none)'}`);
  const started = b.events.find((e): e is Extract<AgentEvent, { type: 'repair_started' }> => e.type === 'repair_started');
  check('B1. the repair pass stopped at its own budget and said so with 2 decimals',
    !!repairStop && /^Repair budget reached \(\$\d+\.\d{2} of \$\d+\.\d{2}\); stopping the repair pass and keeping what it re-recorded\.$/.test(repairStop)
    && !!started && repairStop.includes(`of $${started.budgetUsd.toFixed(2)})`), JSON.stringify({ repairStop, budget: started?.budgetUsd, tail: msgsB.slice(-15) }));
  const ceilingLines = msgsB.filter((m) => m.startsWith('Cost ceiling reached'));
  check('B2. no "Cost ceiling reached" line names the repair budget', ceilingLines.every((m) => !started || !m.includes(String(started.budgetUsd))), JSON.stringify(ceilingLines));
} finally {
  process.chdir(agentCwd);
  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log('');
if (fail > 0) {
  console.log(`FAIL: ${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`OK: smoke-repair-block: ${pass} checks passed (fixture Explorer and Critic through the repair block, the closing Critic paragraph, one rule coverage print, the repair budget line)`);
