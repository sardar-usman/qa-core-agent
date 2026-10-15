/**
 * smoke-console-honesty: the console tells one truth (invariant 72). $0, no
 * model call, local fixtures only.
 *
 *   A. The repair budget stop names itself: "Repair budget reached ($1.55 of
 *      $1.51)", 2 decimals, never "Cost ceiling reached", never an unrounded
 *      float; the run ceiling line keeps its wording. Driven through
 *      runAgentLoop with a fake client, both budgets.
 *   B. The "no discovered page" warning only when true: the saucedemo shape
 *      (entry-page fallback, login planned there) prints none; a feature the
 *      plan does not carry still does; a probed feature never does.
 *   C. No console message is dropped: the CLI's renderer, spawned as a child
 *      process on an events.jsonl, prints a 400-character message cut at the
 *      cap with the marker, the repair decision line whole, a state probe
 *      line whole, and the mid-run resume hint not at all.
 *   D. The skip reason tells the real cause: credentials set and no login
 *      page names that; credentials not provided says so.
 *   E. The "Run the framework" steps are runnable: run in a temp copy of a
 *      fixture run folder, they reach a folder holding package.json.
 *   F. A ceiling cut never reads as a drop: run 5's R9 shape reads
 *      planned-not-explored with "cost ceiling hit mid-scenario".
 *   G. The page-fit rejection line names its rules, or "(cited no rule)".
 *
 *   npx tsx scripts/smoke-console-honesty.ts
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type Anthropic from '@anthropic-ai/sdk';
import { chromium, type Page } from 'playwright';
import { budgetStopLine, runAgentLoop } from '../src/agent/runtime.js';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { pageFitRejectionLine, unreachableFeatureLine, unreachableFeatures, type PlannedScenario, type PlanResult } from '../src/agent/planner.js';
import { planAcrossPages } from '../src/agent/plan-pages.js';
import { NO_LOGIN_PAGE_REASON } from '../src/agent/login-preflight.js';
import { CREDENTIALS_NOT_PROVIDED } from '../src/agent/test-credentials.js';
import { runFrameworkLines, writeFrameworkZip } from '../src/agent/framework-zip.js';
import { CEILING_MID_SCENARIO_DETAIL, computeRuleCoverage, renderRuleCoverage } from '../src/agent/rule-coverage.js';
import { CUT_MARKER, MESSAGE_CAP, messageLine } from '../src/cli/render.js';
import type { RequirementsMap } from '../src/agent/requirements.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-console-honesty-'));

/* ─── A. the repair budget names itself ───────────────────────────────────── */
{
  // Run 44cb3d's numbers: $1.547 spent against the repair budget $1.5053279999999996.
  const before = 'Cost ceiling reached ($1.547 > $1.5053279999999996); stopping the Explorer and salvaging completed scenarios.';
  const repairStop = budgetStopLine('repair', 'stop', { spentUsd: 1.547, limitUsd: 1.5053279999999996, graceUsd: 0.1 });
  console.log(`  before: ${before}`);
  console.log(`  after:  ${repairStop}`);
  check('A1. the repair stop reads "Repair budget reached ($1.55 of $1.51)"', repairStop === 'Repair budget reached ($1.55 of $1.51); stopping the repair pass and keeping what it re-recorded.', repairStop);
  const closeout = budgetStopLine('repair', 'closeout', { spentUsd: 1.547, limitUsd: 1.5053279999999996, graceUsd: 0.1, scenario: 's' });
  const exhausted = budgetStopLine('repair', 'grace-exhausted', { spentUsd: 1.62, limitUsd: 1.5053279999999996, graceUsd: 0.1, scenario: 's' });
  const repairLines = [repairStop, closeout, exhausted];
  check('A2. no repair line says "Cost ceiling" or prints more than 2 decimals of a dollar amount',
    repairLines.every((l) => !l.includes('Cost ceiling') && !/\$\d+\.\d{3,}/.test(l)) && closeout.startsWith('Repair budget reached ($1.55 of $1.51);') && exhausted.startsWith('Repair budget closeout grace exhausted ($1.62 of $1.51 plus the $0.10 grace);'), JSON.stringify(repairLines));
  const runStop = budgetStopLine('run', 'stop', { spentUsd: 5.2345, limitUsd: 5.1, graceUsd: 0.1 });
  check('A3. the run ceiling line keeps its wording', runStop === 'Cost ceiling reached ($5.234 > $5.1); stopping the Explorer and salvaging completed scenarios.', runStop);

  // Through the loop: every response costs about $1.60 (20k in, 60k out at Opus prices).
  const loopMessages = async (budget: 'run' | 'repair' | undefined, maxUsd: number): Promise<string[]> => {
    let calls = 0;
    const client = {
      messages: {
        create: async () => {
          calls++;
          return {
            usage: { input_tokens: 20_000, output_tokens: 60_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            content: [{ type: 'tool_use', id: `t${calls}`, name: 'bogus_tool_never_touches_the_page', input: {} }],
            stop_reason: 'tool_use',
          };
        },
      },
    } as unknown as Anthropic;
    const ctx = createContext({ on: () => {}, off: () => {} } as unknown as Page, 40);
    const messages: string[] = [];
    const r = await runAgentLoop({
      client, model: 'claude-opus-4-7', maxUsd, price: { in: 5.0, out: 25.0, cacheRead: 0.5, cacheWrite: 6.25 }, maxSteps: 40,
      ctx, url: 'https://shop.example/', plan: [], ...(budget ? { budget } : {}),
      onEvent: (e) => { if (e.type === 'message') messages.push(e.text); },
    });
    check(`A4${budget ?? '-default'}. the loop ends at its budget (${budget ?? 'run'})`, r.endedReason === 'cost_ceiling', r.endedReason);
    return messages;
  };
  const repairMsgs = await loopMessages('repair', 1.5053279999999996);
  check('A5. the repair loop prints "Repair budget reached ($1.60 of $1.51)" and no "Cost ceiling reached"',
    repairMsgs.includes('Repair budget reached ($1.60 of $1.51); stopping the repair pass and keeping what it re-recorded.') && !repairMsgs.some((m) => m.includes('Cost ceiling reached')), JSON.stringify(repairMsgs));
  const runMsgs = await loopMessages(undefined, 1);
  check('A6. the run loop still prints "Cost ceiling reached ($1.600 > $1)"', runMsgs.includes('Cost ceiling reached ($1.600 > $1); stopping the Explorer and salvaging completed scenarios.'), JSON.stringify(runMsgs));
  const runtimeSrc = fs.readFileSync(path.join('src', 'agent', 'runtime.ts'), 'utf8');
  check('A7. the repair pass runs its loop with the repair budget label', /repairNote,\s*\n\s*budget: 'repair',/.test(runtimeSrc));
}

/* ─── B. the "no discovered page" warning only when true ──────────────────── */
{
  const rules = (ids: string[]): RequirementsMap['features'][number]['rules'] => ids.map((id) => ({ id, text: `rule ${id}`, type: 'validation' as const }));
  const map = {
    features: [
      { name: 'login', description: 'sign in', rules: rules(['R1', 'R2', 'R3', 'R4']) },
      { name: 'cart', description: 'the cart', rules: rules(['R5', 'R6']) },
    ],
    roles: [],
  } as unknown as RequirementsMap;
  // Saucedemo: discovery fell back to the entry page (no feature tag), the login was planned there.
  const entryOnly: Array<{ url: string; feature?: string }> = [{ url: 'https://www.saucedemo.com/' }];
  const saucePlan: PlannedScenario[] = [
    { name: 'logged in with valid credentials', category: 'happy', rationale: 'r', feature: 'login', ruleIds: ['R1'], pageUrl: 'https://www.saucedemo.com/' },
    { name: 'rejected a locked out user', category: 'negative', rationale: 'r', feature: 'login', ruleIds: ['R3'], pageUrl: 'https://www.saucedemo.com/' },
  ];
  const before = unreachableFeatures(map, entryOnly).map((f) => unreachableFeatureLine(f));
  const after = unreachableFeatures(map, entryOnly, [], saucePlan).map((f) => unreachableFeatureLine(f));
  console.log(`  before: ${before.join(' | ')}`);
  console.log(`  after:  ${after.join(' | ')}`);
  check('B1. the saucedemo shape prints no "no discovered page" line for login (the plan carries it)', !after.some((l) => l.includes('"login"')), JSON.stringify(after));
  check('B2. a feature truly absent still prints it', after.length === 1 && after[0] === 'Feature "cart" has 2 rules and no discovered page; its rules will report not-planned', JSON.stringify(after));
  const tagOnly = unreachableFeatures(map, entryOnly, [], [{ feature: 'login' }]);
  const citeOnly = unreachableFeatures(map, entryOnly, [], [{ ruleIds: ['R2'] }]);
  check('B3. a planned scenario tagged with the feature carries it; so does one citing one of its rules', !tagOnly.some((f) => f.name === 'login') && !citeOnly.some((f) => f.name === 'login'), JSON.stringify({ tagOnly, citeOnly }));
  const probed = unreachableFeatures(map, entryOnly, [{ feature: 'cart' }], saucePlan);
  check('B4. a probed feature gets the probe line, never this one (invariant 71)', probed.length === 0, JSON.stringify(probed));
  const cov = computeRuleCoverage({ map, planned: saucePlan, scenarios: [], unreachableFeatures: unreachableFeatures(map, entryOnly, [], saucePlan).map((f) => f.name) });
  check('B5. coverage agrees: login rules are never not-reachable, cart rules are', cov.uncovered.filter((u) => u.reason === 'not-reachable').map((u) => u.ruleId).join(',') === 'R5,R6', JSON.stringify(cov.uncovered));
  const runtimeSrc = fs.readFileSync(path.join('src', 'agent', 'runtime.ts'), 'utf8');
  check('B6. the runtime prints the line after planning, with the plan', /unreachableFeatures\(opts\.requirements, pages, probes\.probes, combined\)/.test(runtimeSrc) && runtimeSrc.indexOf('unreachableFeatures(opts.requirements, pages, probes.probes, combined)') > runtimeSrc.indexOf('const planned2 = await planAcrossPages('));
}

/* ─── C. no console message is dropped ────────────────────────────────────── */
{
  const generic = `Explorer note: ${'x'.repeat(400 - 'Explorer note: '.length)}`;
  const repairLine = `repair pass: 10 of 10 rework scenario(s), budget $1.51 (ceiling minus spend $1.51 remaining, reserve $0.90 the floor); explorer cost this run $0.2745 per recorded scenario, a repair estimated at $0.1372 (half, scaled by step count), so the budget funds 10 of 10 cheapest first; repairing: ${Array.from({ length: 10 }, (_, i) => `"scenario number ${i + 1}"`).join(', ')}`;
  const probeLine = `State probe "cart": revealed /checkout by clicking ${'y'.repeat(300)}`;
  const hint = 'Run stopped: cost ceiling hit. State saved. Resume with: npm run explore -- --resume output/x/checkpoint.json';
  check('C0. the fixtures are over the cap', generic.length === 400 && repairLine.length > MESSAGE_CAP && probeLine.length > MESSAGE_CAP);
  const eventsFile = path.join(tmpRoot, 'events.jsonl');
  fs.writeFileSync(eventsFile, [generic, repairLine, probeLine, hint, 'a short line'].map((text) => JSON.stringify({ t: '2026-10-14T00:00:00.000Z', type: 'message', text })).join('\n') + '\n');
  const child = spawnSync('npx', ['tsx', path.join('scripts', 'render-events.ts'), eventsFile], { encoding: 'utf8' });
  const out = child.stdout ?? '';
  const lines = out.split('\n').map((l) => l.trim());
  const cut = generic.slice(0, MESSAGE_CAP) + CUT_MARKER;
  console.log(`  before: (the 400-character message was not printed: the CLI dropped any message of 240 characters or more)`);
  console.log(`  after:  ${cut}`);
  check('C1. the spawned renderer exits 0', child.status === 0, child.stderr);
  check('C2. the 400-character message appears, cut at the cap with the marker', lines.includes(cut) && cut.endsWith(' ... (full line in events.jsonl)'), out.slice(0, 600));
  check('C3. the repair decision line appears whole', lines.includes(repairLine), out);
  check('C4. a state probe line appears whole', lines.includes(probeLine));
  check('C5. the mid-run resume hint is not printed (the CLI prints it once, last, whole)', !out.includes('Run stopped:'));
  check('C6. a short line prints unchanged', lines.includes('a short line'));
  check('C7. messageLine never returns null except for the hint copy', messageLine(generic) !== null && messageLine(repairLine) === repairLine && messageLine(hint) === null && messageLine('repair pass skipped: no budget') === 'repair pass skipped: no budget');
  const cliSrc = fs.readFileSync(path.join('src', 'cli', 'explore.ts'), 'utf8');
  check('C8. the CLI renders events through the renderer and holds no length drop of its own', cliSrc.includes('createEventRenderer(') && !/length < 240/.test(cliSrc));
}

/* ─── D. the skip reason tells the real cause ─────────────────────────────── */
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><body><h1>Sign in</h1><form><input data-testid="email" name="email"><input data-testid="password" type="password" name="password"><button type="submit">Login</button></form></body></html>');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await installEvalShim(context);
  const page = await context.newPage();
  const skipWith = async (accountSkipReason?: string): Promise<{ ok: boolean; reason?: string; error?: string }> => {
    const ctx = createContext(page, 60);
    ctx.testCredentials = null;
    if (accountSkipReason) ctx.accountSkipReason = accountSkipReason;
    await runTool(ctx, { name: 'begin_scenario', input: { name: 'logged in with valid credentials', category: 'happy', feature: 'login' } });
    await runTool(ctx, { name: 'navigate', input: { url: `${siteUrl}/` } });
    const r = await runTool(ctx, { name: 'fill', input: { intent: 'email input', testid: 'email', credential: 'user' } });
    return { ok: r.ok, ...(ctx.skipped[0] ? { reason: ctx.skipped[0].reason } : {}), ...(r.ok ? {} : { error: (r as { error?: string }).error }) };
  };
  const noPage = await skipWith(NO_LOGIN_PAGE_REASON);
  const notSet = await skipWith();
  console.log(`  before: Skipped "logged in with valid credentials": test credentials not provided (credentials were set, no login page found)`);
  console.log(`  after:  ${noPage.error ?? ''}`);
  check('D1. credentials set and no login page: the skip reason names that', noPage.ok === false && noPage.reason === 'no login page found; test credentials were set' && NO_LOGIN_PAGE_REASON === 'no login page found; test credentials were set', JSON.stringify(noPage));
  check('D2. credentials not provided: the skip reason says so', notSet.ok === false && notSet.reason === CREDENTIALS_NOT_PROVIDED && notSet.reason === 'test credentials not provided', JSON.stringify(notSet));
  await context.close();
} finally {
  await browser.close();
  server.close();
}

/* ─── E. the "Run the framework" steps are runnable ───────────────────────── */
{
  const fixtureRun = path.join(tmpRoot, 'output', 'shop-example', '20261014T000000Z-abc123');
  const fw = path.join(tmpRoot, 'emit', 'shop-automation-framework');
  fs.mkdirSync(path.join(fw, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(fw, 'package.json'), JSON.stringify({ name: 'shop-automation-framework', private: true }));
  fs.writeFileSync(path.join(fw, 'tests', 'a.spec.ts'), '// fixture\n');
  fs.mkdirSync(fixtureRun, { recursive: true });
  fs.writeFileSync(path.join(fixtureRun, 'run-report.json'), '{}');
  const outcome = writeFrameworkZip({ frameworkDir: fw, destDir: fixtureRun, zipRootName: 'shop-automation-framework' });
  check('E0. the fixture zip is written', !!outcome.written, JSON.stringify(outcome.failed ?? outcome.refused));
  const outDirRel = path.relative(tmpRoot, fixtureRun);
  const runLines = runFrameworkLines(outcome, { outDirRel, zipRel: path.join(outDirRel, 'shop-automation-framework.zip') });
  console.log(`  before: Run the framework: | cd ${outDirRel} | npm install | npx playwright test`);
  console.log(`  after:  ${runLines.filter((l) => l.trim()).join(' | ')}`);
  const steps = runLines.slice(runLines.indexOf('Run the framework:') + 1).map((l) => l.trim()).filter((l, i, a) => l && a.slice(0, i).every((x) => x));
  check('E1. the steps unzip the real zip, cd into the extracted folder, then install and test',
    JSON.stringify(steps) === JSON.stringify([`cd ${outDirRel}`, 'unzip -o shop-automation-framework.zip', 'cd shop-automation-framework', 'npm install', 'npx playwright test']), JSON.stringify(steps));
  // Run them in a temp copy of the run folder (a copy of the parent so the relative cd resolves), stopping before npm install.
  const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-run-copy-'));
  fs.cpSync(path.join(tmpRoot, 'output'), path.join(copyRoot, 'output'), { recursive: true });
  const shell = [...steps.filter((s) => s.startsWith('cd ') || s.startsWith('unzip ')), 'test -f package.json', 'pwd'].join(' && ');
  const ran = spawnSync('sh', ['-c', shell], { cwd: copyRoot, encoding: 'utf8' });
  check('E2. run in a temp copy of the run folder, the printed steps reach a folder that contains package.json',
    ran.status === 0 && ran.stdout.trim().endsWith(path.join(outDirRel, 'shop-automation-framework')), `${ran.status} ${ran.stdout} ${ran.stderr}`);
  check('E3. the source run folder is untouched (no extracted folder there)', !fs.existsSync(path.join(fixtureRun, 'shop-automation-framework')));
  check('E4. a refused zip still prints no steps', runFrameworkLines({ refused: { reason: 'r', files: [] } }, { outDirRel }).length === 0);
  fs.rmSync(copyRoot, { recursive: true, force: true });
}

/* ─── F. a ceiling cut never reads as a drop (run 5 R9) ───────────────────── */
{
  const map = {
    features: [{ name: 'cart', description: 'the cart', rules: [{ id: 'R9', text: 'Removing a product from the cart removes its row and updates the total.', type: 'behavior' }] }],
    roles: [],
  } as unknown as RequirementsMap;
  const name = 'removed a product from the cart and its row disappeared, and the total updated';
  const planned = [{ name, ruleIds: ['R9'] }];
  const incomplete = [{ name, reason: 'cost ceiling hit mid-scenario; in-progress work discarded' }];
  const beforeCov = computeRuleCoverage({ map, planned, scenarios: [] });
  const afterCov = computeRuleCoverage({ map, planned, scenarios: [], incomplete });
  const beforeLine = renderRuleCoverage(beforeCov).find((l) => l.includes('R9')) ?? '';
  const afterLine = renderRuleCoverage(afterCov).find((l) => l.includes('R9')) ?? '';
  console.log(`  before: ${beforeLine.trim()}`);
  console.log(`  after:  ${afterLine.trim()}`);
  check('F1. R9 reads planned-not-explored with "cost ceiling hit mid-scenario"', afterCov.uncovered[0]?.reason === 'planned-not-explored' && afterCov.uncovered[0]?.detail === 'cost ceiling hit mid-scenario' && CEILING_MID_SCENARIO_DETAIL === 'cost ceiling hit mid-scenario', JSON.stringify(afterCov.uncovered));
  check('F2. the rendered line says so', afterLine.includes('R9 (planned-not-explored: cost ceiling hit mid-scenario)'), afterLine);
  const rephrased = computeRuleCoverage({ map, planned, scenarios: [], incomplete: [{ name: `[edge] ${name}`, reason: incomplete[0]!.reason }] });
  check('F3. a recorded name with a prefix still claims the planned name (standing rule 1)', rephrased.uncovered[0]?.reason === 'planned-not-explored', JSON.stringify(rephrased.uncovered));
  const never = computeRuleCoverage({ map, planned, scenarios: [], incomplete: [{ name, reason: 'never explored: cost ceiling hit before this scenario started' }] });
  check('F4. a never-started scenario reads planned-not-explored from the incomplete list too, with no detail (as before)', never.uncovered[0]?.reason === 'planned-not-explored' && never.uncovered[0]?.detail === undefined, JSON.stringify(never.uncovered));
  const dropped = computeRuleCoverage({ map, planned, scenarios: [], incomplete: [{ name, reason: 'budget exhausted mid-scenario' }], dropReasons: new Map([[name, 'replay: failed']]) });
  check('F5. any other incomplete reason is not a ceiling cut', dropped.uncovered[0]?.reason === 'planned-but-dropped', JSON.stringify(dropped.uncovered));
  const emittedSrc = fs.readFileSync(path.join('src', 'agent', 'emitted-check.ts'), 'utf8');
  check('F6. the emitted-spec check rebuilds coverage with the same incomplete list', emittedSrc.includes('incomplete: report.reconciliation.incomplete'));
}

/* ─── G. the page-fit rejection line names its rules ──────────────────────── */
{
  const cited: PlannedScenario = { name: 'sorted rentals by price', category: 'happy', rationale: 'r', feature: 'rentals', ruleIds: ['R4', 'R5'] };
  const none: PlannedScenario = { name: 'filled the first name', category: 'negative', rationale: 'r', feature: 'contact' };
  const reason = 'names price which the page snapshot does not show';
  const result = (rejected: PlannedScenario[]): PlanResult => ({
    scenarios: [], pageTitle: 't', costUsd: 0, fillableFields: 0, dropped: [], rejected: [], citationDrops: [],
    pageFitRejected: rejected.map((scenario) => ({ scenario, control: 'price', reason })), contradictionRejected: [], ruleRetries: [],
  } as unknown as PlanResult);
  const msgs: string[] = [];
  await planAcrossPages({
    targets: [{ page: { url: 'https://shop.example/rentals', source: 'crawl' } }, { page: { url: 'https://shop.example/contact', source: 'crawl' } }],
    planFn: async (a) => result(a.url.endsWith('/rentals') ? [cited] : [none]),
    onMessage: (t) => msgs.push(t),
  });
  const lines = msgs.filter((m) => m.startsWith('Rejected page-fit scenario'));
  console.log(`  before: Rejected page-fit scenario: "sorted rentals by price" on https://shop.example/rentals: ${reason}`);
  console.log(`  after:  ${lines[0] ?? ''}`);
  check('G1. the line ends with the rule ids the scenario cited', lines[0] === `Rejected page-fit scenario: "sorted rentals by price" on https://shop.example/rentals: ${reason} (cited R4, R5)`, JSON.stringify(lines));
  check('G2. a scenario that cited none says "(cited no rule)"', lines[1] === `Rejected page-fit scenario: "filled the first name" on https://shop.example/contact: ${reason} (cited no rule)`, JSON.stringify(lines));
  check('G3. the single-page path uses the same line', pageFitRejectionLine(cited, 'u', 'r') === 'Rejected page-fit scenario: "sorted rentals by price" on u: r (cited R4, R5)' && fs.readFileSync(path.join('src', 'agent', 'runtime.ts'), 'utf8').includes('pageFitRejectionLine(r.scenario, opts.url, r.reason)'));
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('');
if (fail > 0) {
  console.log(`FAIL: ${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`OK: smoke-console-honesty: ${pass} checks passed (repair budget line, no-page warning, no dropped message, skip reason, runnable steps, ceiling cut, page-fit rule ids)`);
