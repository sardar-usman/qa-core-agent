/**
 * Locks invariant 69: a dropped scenario keeps its recorded trace on the
 * run-report, under the plan's canonical name, credential-redacted in every
 * copy, and nothing that emits a framework reads it.
 *
 *   A. one fixture drop per stage (gate, critic, repair with and without a
 *      repair attempt, replay, stability, emitted_failed): each has its
 *      trace with steps, built by the runtime's own traceStoreForRun; the
 *      identity check holds
 *   B. a deliberately missing trace prints the loud line and sets
 *      droppedTracesWarning; nothing dropped omits the key
 *   C. canonical names: a recorded name with a prefix and lost quotes is
 *      filed under the planned name with recordedName kept; no plan, the
 *      recorded name stands in; a plan and no match prints the line
 *   D. the gate traces are recorded by the tool itself (a RULE 1 rejection
 *      and a planned-page second strike)
 *   E. redaction: the happy login itself is dropped; both written files
 *      (the working-directory run-report.json and the zipped copy) are read
 *      from disk and the real password appears in neither droppedTraces copy;
 *      a wrong_password negative's value is kept; a later stage still masks
 *      the password; the env credential variables join the secret set
 *   F. transcribe: a report with droppedTraces emits a framework
 *      byte-identical to the same report without the field (TS and JS, POM
 *      and single file); the zipped report differs only by the field
 *   G. the consumers never read the field (static)
 *
 * Zero browser, zero LLM. Every tool call result is checked (standing rule 7).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { reconcile, unmatchedDropLine } from '../src/agent/reconcile.js';
import { attachDroppedTraces, droppedTracesIdentity, storeFromDroppedTraces, storeTrace, traceStoreForRun, recordOf } from '../src/agent/dropped-traces.js';
import { CREDENTIAL_REDACTION, credentialSecrets } from '../src/agent/datasets.js';
import { writeReportFiles } from '../src/agent/emitted-check.js';
import { scaffold } from '../src/agent/scaffold.js';
import { transcribe } from '../src/agent/transcriber.js';
import { runTranscribeRequest } from '../src/server/run-explore.js';
import { createContext, runTool } from '../src/agent/tools.js';
import type { RunReport, Scenario, SelectorRecord, TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const URL = 'https://shop.example.com/';
const cost: RunReport['cost'] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 };
const cascadeStats: RunReport['cascadeStats'] = { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 };
const t = (arg: string, intent: string): SelectorRecord => ({ level: 'testid', arg, intent });
const nav = (p: string): TraceStep => ({ kind: 'navigate', url: `${URL.replace(/\/$/, '')}${p}` });
const fill = (arg: string, intent: string, value: string): TraceStep => ({ kind: 'fill', target: t(arg, intent), value });
const click = (arg: string): TraceStep => ({ kind: 'click', target: t(arg, `${arg} button`) });
const visible = (arg: string): TraceStep => ({ kind: 'assert', name: `${arg} visible`, assertion: { type: 'toBeVisible', target: t(arg, `${arg} message`), timeout: 10000 } });
const sc = (name: string, steps: TraceStep[], category: Scenario['category'] = 'happy', feature = 'shop'): Scenario => ({ name, category, feature, steps });
const planEntry = (name: string, category = 'happy', pageUrl?: string): NonNullable<RunReport['plan']>[number] => ({ name, category, rationale: 'r', feature: 'shop', ...(pageUrl ? { pageUrl } : {}) });

/* ─── A. one drop per stage, each with its trace ─────────────────────────── */
const N = {
  ok: 'filtered the list and saw fewer products',
  gate: 'sorted the list by price and saw the cheapest first',
  critic: 'opened a product and saw its name',
  unfunded: 'added a product and the badge went up',
  attempt: 'removed a product and the row went away',
  judged: 'rejected the contact form with an empty message',
  replay: 'searched for pliers and saw matching results',
  stability: 'paged to the second page of results',
  emitted: 'toggled the eco filter and the list narrowed',
};
const steps = Object.fromEntries(Object.entries(N).map(([k], i) => [k, [nav(`/${k}`), click(`go-${i}`), visible(`done-${i}`)]])) as Record<keyof typeof N, TraceStep[]>;
const attemptSteps = [nav('/attempt'), click('retry')];
const judgedRepair = [nav('/judged'), click('send'), visible('message-error')];
const recorded = (Object.keys(N) as Array<keyof typeof N>).filter((k) => k !== 'gate').map((k) => sc(N[k], steps[k]));
const stageReport = (): RunReport => ({
  url: URL, language: 'ts', cascadeStats, cost, steps: 0, startedAt: '', finishedAt: '',
  scenarios: [sc(N.ok, steps.ok)],
  plan: Object.values(N).map((n) => planEntry(n, 'happy', n === N.replay ? `${URL}search` : undefined)),
  gate: { broken: [{ scenario: N.gate, reason: 'hard sleep recorded', attempts: 2 }], injections: [] },
  review: {
    summary: '',
    verdicts: [
      { scenario: N.ok, verdict: 'pass', reasons: [], required_fixes: [] },
      { scenario: N.critic, verdict: 'reject', reasons: ['vacuous'], required_fixes: [] },
      { scenario: N.unfunded, verdict: 'rework', reasons: ['weak'], required_fixes: ['compare the badge'] },
      { scenario: N.attempt, verdict: 'rework', reasons: ['weak'], required_fixes: ['assert the row count'] },
      { scenario: N.judged, verdict: 'rework', reasons: ['required fix not applied: x'], required_fixes: [] },
      { scenario: N.replay, verdict: 'pass', reasons: [], required_fixes: [] },
      { scenario: N.stability, verdict: 'pass', reasons: [], required_fixes: [] },
      { scenario: N.emitted, verdict: 'pass', reasons: [], required_fixes: [] },
    ],
    repair: [
      { scenario: N.unfunded, first: 'rework', outcome: 'dropped', notRepaired: 'budget funds 2 of 3' },
      { scenario: N.attempt, first: 'rework', outcome: 'dropped', notRepaired: 'mid-repair when the cost ceiling hit' },
      { scenario: N.judged, first: 'rework', second: 'rework', outcome: 'dropped' },
    ],
  },
  replay: { passed: 3, failed: 1, durationMs: 0, verdicts: [{ name: N.replay, passed: false, failedStep: 1, stepKind: 'click', error: 'timeout', durationMs: 0 }, { name: N.ok, passed: true, durationMs: 0 }, { name: N.stability, passed: true, durationMs: 0 }, { name: N.emitted, passed: true, durationMs: 0 }] },
  stability: { iterations: 3, passed: 2, flaked: 1, flakeRate: 0.33, durationMs: 0, verdicts: [{ name: N.stability, passes: 1, iterations: 3, stable: false, pattern: 'PFF', classification: 'flaky' }, { name: N.ok, passes: 3, iterations: 3, stable: true, pattern: 'PPP', classification: 'stable' }, { name: N.emitted, passes: 3, iterations: 3, stable: true, pattern: 'PPP', classification: 'stable' }] },
  emittedFailed: [{ scenario: N.emitted, error: 'expect(locator).toBeVisible() failed' }],
  findings: [],
} as unknown as RunReport);
const buildStore = () => {
  const store = traceStoreForRun({
    gateBroken: new Map([[N.gate, sc(N.gate, steps.gate)]]),
    recorded,
    repaired: [sc(N.judged, judgedRepair)],
    repairAttempts: { [N.attempt]: attemptSteps },
    replayed: recorded.filter((s) => [N.ok, N.replay, N.stability, N.emitted, N.judged].includes(s.name)),
    stabilityInput: recorded.filter((s) => [N.ok, N.stability, N.emitted].includes(s.name)),
  });
  // The emitted-spec check hands its transcribed trace over the same way (emitted-check.ts).
  storeTrace(store, 'emitted_failed', N.emitted, recordOf(sc(N.emitted, steps.emitted)));
  return store;
};
{
  const report = stageReport();
  report.reconciliation = reconcile(report);
  const logged: string[] = [];
  attachDroppedTraces(report, buildStore(), (l) => logged.push(l));
  const dt = report.droppedTraces ?? [];
  const by = (name: string) => dt.find((x) => x.name === name);
  const same = (a: TraceStep[] | undefined, b: TraceStep[]) => JSON.stringify(a) === JSON.stringify(b);
  check('A0. the fixture funnel balances: 9 planned = 1 generated + 7 dropped + 1 emitted_failed', report.reconciliation.balanced && report.reconciliation.dropped.length === 7 && (report.reconciliation.emitted_failed ?? []).length === 1, JSON.stringify(report.reconciliation.dropped.map((d) => [d.stage, d.name])));
  check('A1. gate: the rejected trace', by(N.gate)?.stage === 'gate' && same(by(N.gate)?.steps, steps.gate));
  check('A2. critic (reject): the recorded trace, no repairSteps', by(N.critic)?.stage === 'critic' && same(by(N.critic)?.steps, steps.critic) && by(N.critic)?.repairSteps === undefined);
  check('A3. repair without an attempt: the first-pass trace, no repairSteps', by(N.unfunded)?.stage === 'repair' && same(by(N.unfunded)?.steps, steps.unfunded) && by(N.unfunded)?.repairSteps === undefined);
  check('A4. repair with an attempt: the first-pass trace in steps, the attempt in repairSteps', by(N.attempt)?.stage === 'repair' && same(by(N.attempt)?.steps, steps.attempt) && same(by(N.attempt)?.repairSteps, attemptSteps));
  check('A5. critic after a judged repair: the first-pass trace and the repaired trace', by(N.judged)?.stage === 'critic' && same(by(N.judged)?.steps, steps.judged) && same(by(N.judged)?.repairSteps, judgedRepair));
  check('A6. replay: the replayed trace, with the planned page', by(N.replay)?.stage === 'replay' && same(by(N.replay)?.steps, steps.replay) && by(N.replay)?.pageUrl === `${URL}search`);
  check('A7. stability: the replayed trace', by(N.stability)?.stage === 'stability' && same(by(N.stability)?.steps, steps.stability));
  check('A8. emitted_failed: the transcribed trace', by(N.emitted)?.stage === 'emitted_failed' && same(by(N.emitted)?.steps, steps.emitted));
  check('A9. every trace has steps, carries the drop reason, category and feature', dt.length === 8 && dt.every((x) => x.steps.length > 0 && x.reason.length > 0 && x.category === 'happy' && x.feature === 'shop'));
  const id = droppedTracesIdentity(report.reconciliation, dt);
  check('A10. the identity check holds: one trace per drop name, no warning line, no droppedTracesWarning key', id.missing.length === 0 && id.extra.length === 0 && logged.length === 0 && !('droppedTracesWarning' in report), JSON.stringify({ id, logged }));
  check('A11. no truncation: a 400-step trace is kept whole', (() => {
    const r = stageReport();
    r.reconciliation = reconcile(r);
    const long = Array.from({ length: 400 }, (_, i) => nav(`/p${i}`));
    const store = buildStore();
    storeTrace(store, 'gate', N.gate, recordOf(sc(N.gate, long)));
    attachDroppedTraces(r, store, () => {});
    return r.droppedTraces?.find((x) => x.name === N.gate)?.steps.length === 400;
  })());
}

/* ─── B. a missing trace is loud; nothing dropped omits the key ──────────── */
{
  const report = stageReport();
  report.reconciliation = reconcile(report);
  const store = buildStore();
  store.get('stability')!.delete(N.stability);
  const logged: string[] = [];
  attachDroppedTraces(report, store, (l) => logged.push(l));
  check('B1. a deliberately missing trace prints one loud WARNING line naming the drop', logged.length === 1 && logged[0]!.startsWith('WARNING: droppedTraces does not match the drops: 1 drop(s) with no trace: ') && logged[0]!.includes(JSON.stringify(N.stability)), JSON.stringify(logged));
  check('B2. and sets droppedTracesWarning with the same text', report.droppedTracesWarning === logged[0]!.replace(/^WARNING: /, ''), report.droppedTracesWarning);
  const extra = droppedTracesIdentity(report.reconciliation, [...(report.droppedTraces ?? []), { name: 'a trace with no drop', stage: 'replay', reason: 'x', steps: [] }]);
  check('B3. a trace with no drop is named as extra', extra.extra.length === 1 && /1 trace\(s\) with no drop: "a trace with no drop"/.test(extra.warning ?? ''), extra.warning);
  const clean: RunReport = { url: URL, language: 'ts', cascadeStats, cost, steps: 0, startedAt: '', finishedAt: '', scenarios: [sc(N.ok, steps.ok)], plan: [planEntry(N.ok)], findings: [] };
  clean.reconciliation = reconcile(clean);
  attachDroppedTraces(clean, buildStore(), () => {});
  check('B4. nothing dropped: the droppedTraces key is omitted, as is the warning', !('droppedTraces' in clean) && !('droppedTracesWarning' in clean) && !JSON.stringify(clean).includes('droppedTraces'));
}

/* ─── C. canonical names ──────────────────────────────────────────────── */
{
  const PLANNED = 'browsed products in the "Other" category and saw name, image, and price';
  const ECHO = '8. [happy] browsed products in the Other category and saw name, image, and price';
  const r: RunReport = {
    url: URL, language: 'ts', cascadeStats, cost, steps: 0, startedAt: '', finishedAt: '',
    scenarios: [], plan: [planEntry(PLANNED)], findings: [],
    review: { summary: '', verdicts: [{ scenario: ECHO, verdict: 'reject', reasons: ['vacuous'], required_fixes: [] }] },
  };
  const lines: string[] = [];
  r.reconciliation = reconcile(r, { onUnmatchedName: (m) => lines.push(m) });
  const d = r.reconciliation.dropped[0];
  check('C1. a recorded name with a prefix and lost quotes is filed under the planned name, recordedName kept', d?.name === PLANNED && d.recordedName === ECHO && lines.length === 0, JSON.stringify(d));
  attachDroppedTraces(r, (() => { const s = traceStoreForRun({ gateBroken: new Map(), recorded: [sc(ECHO, steps.critic)], repaired: [], repairAttempts: {}, replayed: [], stabilityInput: [] }); return s; })(), () => {});
  check('C2. droppedTraces carries the same canonical name and recordedName', r.droppedTraces?.length === 1 && r.droppedTraces[0]!.name === PLANNED && r.droppedTraces[0]!.recordedName === ECHO && !r.droppedTracesWarning, JSON.stringify(r.droppedTraces));
  const same = reconcile({ ...r, review: { summary: '', verdicts: [{ scenario: PLANNED, verdict: 'reject', reasons: [], required_fixes: [] }] } });
  check('C3. a drop recorded under the planned name carries no recordedName', same.dropped[0]?.name === PLANNED && !('recordedName' in same.dropped[0]!));
  const noPlan = reconcile({ ...r, plan: undefined }, { onUnmatchedName: (m) => lines.push(m) });
  check('C4. no plan in the run: the recorded name stands in, no recordedName, nothing logged', noPlan.dropped[0]?.name === ECHO && !('recordedName' in noPlan.dropped[0]!) && lines.length === 0 && noPlan.unmatchedDropNames === undefined);
  const STRAY = 'checked the footer links all resolve';
  const unmatched = reconcile({ ...r, review: { summary: '', verdicts: [{ scenario: STRAY, verdict: 'reject', reasons: [], required_fixes: [] }] } }, { onUnmatchedName: (m) => lines.push(m) });
  check('C5. a plan and no match: the recorded name is kept and one loud line is printed, word for word',
    unmatched.dropped[0]?.name === STRAY && lines.length === 1 && lines[0] === `drop name: recorded name "${STRAY}" matched no planned name` && lines[0] === unmatchedDropLine(STRAY) && JSON.stringify(unmatched.unmatchedDropNames) === JSON.stringify([STRAY]), JSON.stringify(lines));
  const emitted = reconcile({ ...r, review: undefined, emittedFailed: [{ scenario: ECHO, error: 'failed' }, { scenario: 'contact: empty message', error: 'failed', dataCase: true }] }, { onUnmatchedName: (m) => lines.push(m) });
  check('C6. emitted_failed is filed under the planned name too; a data-driven case keeps its "<feature>: <case>" name and is never reported unmatched',
    emitted.emitted_failed?.[0]?.name === PLANNED && emitted.emitted_failed[0]!.recordedName === ECHO && emitted.emitted_failed[1]?.name === 'contact: empty message' && !('recordedName' in emitted.emitted_failed[1]!) && lines.length === 1, JSON.stringify({ e: emitted.emitted_failed, lines }));
  const shippedClaims = reconcile({ ...r, scenarios: [sc(PLANNED, steps.ok)] }, { onDuplicate: () => {}, onUnmatchedName: (m) => lines.push(m) });
  check('C7. a planned name a shipped scenario already fulfils is not handed to a drop as well', shippedClaims.dropped.length === 1 && shippedClaims.dropped[0]!.name === ECHO && lines.length === 2 && lines[1] === unmatchedDropLine(ECHO), JSON.stringify(shippedClaims.dropped));
}

/* ─── D. the tool records the gate's rejected trace ──────────────────────── */
{
  const stubPage = { on: () => {}, off: () => {} } as unknown as Page;
  const ctx = createContext(stubPage, 80);
  const NAME = 'waited for the cart and saw the badge';
  const sleepy: TraceStep[] = [nav('/cart'), { kind: 'wait', ms: 2000 } as TraceStep, visible('badge')];
  for (const attempt of [1, 2]) {
    const begun = await runTool(ctx, { name: 'begin_scenario', input: { name: NAME, category: 'happy' } });
    check(`D${attempt}a. begin_scenario accepted (attempt ${attempt})`, begun.ok === true, begun.error);
    ctx.current!.steps.push(...sleepy);
    const ended = await runTool(ctx, { name: 'end_scenario', input: {} });
    check(`D${attempt}b. end_scenario refused by the gate (attempt ${attempt})`, ended.ok === false && /RULE 1/.test(ended.error ?? ''), ended.error);
  }
  check('D3. the second refusal records the scenario as gate-broken with the rejected trace', ctx.brokenByGate.length === 1 && JSON.stringify(ctx.gateBrokenTraces.get(NAME)?.steps) === JSON.stringify(sleepy), JSON.stringify([...ctx.gateBrokenTraces.keys()]));

  const pctx = createContext(stubPage, 80);
  const RENTAL = 'clicked a rental product and saw its detail page';
  pctx.plannedNames = [RENTAL];
  pctx.plannedPages = new Map([[RENTAL, { pageUrl: `${URL}rentals` }]]);
  const elsewhere: TraceStep[] = [nav('/category/hand-tools'), visible('product')];
  for (const attempt of [1, 2]) {
    const begun = await runTool(pctx, { name: 'begin_scenario', input: { name: `${RENTAL} on the listing`, category: 'happy' } });
    check(`D4.${attempt}a. begin_scenario accepted`, begun.ok === true, begun.error);
    pctx.current!.steps.push(...elsewhere);
    const ended = await runTool(pctx, { name: 'end_scenario', input: {} });
    check(`D4.${attempt}b. end_scenario refused (planned-page violation)`, ended.ok === false, ended.error);
  }
  check('D5. a planned-page second strike keeps the rejected trace under the planned name', pctx.brokenByGate[0]?.scenario === RENTAL && JSON.stringify(pctx.gateBrokenTraces.get(RENTAL)?.steps) === JSON.stringify(elsewhere));
}

/* ─── E. redaction in both written copies ───────────────────────────────── */
const PASSWORD = 'Sup3r-Secret-Pa55';
const USER = 'customer@shop.example.com';
const happyLogin = sc('logged in with valid credentials', [nav('/auth/login'), fill('email', 'email input', USER), fill('password', 'password input', PASSWORD), click('login-submit'), visible('nav-menu')], 'happy', 'login');
const wrongPassword = sc('rejected login with a wrong password', [nav('/auth/login'), fill('email', 'email input', 'nobody@shop.example.com'), fill('password', 'password input', 'wrong_password'), click('login-submit'), visible('login-error')], 'negative', 'login');
const loginReport = (): RunReport => {
  const r: RunReport = {
    url: URL, language: 'ts', cascadeStats, cost, steps: 0, startedAt: '', finishedAt: '',
    scenarios: [wrongPassword],
    plan: [planEntry(happyLogin.name), planEntry(wrongPassword.name, 'negative')],
    replay: { passed: 1, failed: 1, durationMs: 0, verdicts: [{ name: happyLogin.name, passed: false, failedStep: 4, stepKind: 'assert', error: 'timeout', durationMs: 0 }, { name: wrongPassword.name, passed: true, durationMs: 0 }] },
    findings: [],
  } as unknown as RunReport;
  r.reconciliation = reconcile(r);
  return r;
};
{
  const report = loginReport();
  attachDroppedTraces(report, traceStoreForRun({ gateBroken: new Map(), recorded: [happyLogin, wrongPassword], repaired: [], repairAttempts: {}, replayed: [happyLogin, wrongPassword], stabilityInput: [] }), () => {});
  check('E0. the dropped happy login has its trace', report.droppedTraces?.length === 1 && report.droppedTraces[0]!.name === happyLogin.name && report.droppedTraces[0]!.stage === 'replay');
  check('E1. in memory the dropped trace is already redacted (the gateway forwards this object)', !JSON.stringify(report.droppedTraces).includes(PASSWORD) && JSON.stringify(report.droppedTraces).includes(CREDENTIAL_REDACTION));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-dropped-'));
  const runDir = path.join(root, 'run');
  writeReportFiles(runDir, report);
  const fw = path.join(root, 'fw');
  scaffold({ report, outDir: fw, siteName: 'shop.example.com' });
  const working = JSON.parse(fs.readFileSync(path.join(runDir, 'run-report.json'), 'utf8')) as RunReport;
  const zipped = JSON.parse(fs.readFileSync(path.join(fw, 'run-report.json'), 'utf8')) as RunReport;
  check('E2. working-directory run-report.json, read from disk: the real password is in no droppedTraces step, and the user is masked too', !JSON.stringify(working.droppedTraces).includes(PASSWORD) && !JSON.stringify(working.droppedTraces).includes(USER) && working.droppedTraces?.[0]?.steps.filter((s) => s.kind === 'fill' && s.value === CREDENTIAL_REDACTION).length === 2);
  check('E3. the zipped copy, read from disk: the real password is in no droppedTraces step', !JSON.stringify(zipped.droppedTraces).includes(PASSWORD) && zipped.droppedTraces?.[0]?.steps.some((s) => s.kind === 'fill' && s.value === CREDENTIAL_REDACTION) === true);
  check('E4. the wrong_password negative keeps its value in both copies (test data, invariant 43)', [working, zipped].every((r) => r.scenarios[0]!.steps.some((s) => s.kind === 'fill' && s.value === 'wrong_password')));
  check('E5. the real password appears nowhere in the zipped copy', !fs.readFileSync(path.join(fw, 'run-report.json'), 'utf8').includes(PASSWORD));

  // A later stage (the emitted-spec check) drops another scenario whose
  // trace types the password: the password was hidden in memory by the
  // first redaction, and is still masked (the secret set is remembered).
  const authed = sc('checked the order history after signing in', [nav('/auth/login'), fill('password', 'password input', PASSWORD), click('login-submit'), visible('orders')], 'happy', 'orders');
  report.reconciliation = reconcile({ ...report, emittedFailed: [{ scenario: wrongPassword.name, error: 'failed' }], scenarios: [] } as RunReport);
  const later = storeFromDroppedTraces(report.droppedTraces);
  storeTrace(later, 'emitted_failed', wrongPassword.name, recordOf(authed));
  attachDroppedTraces(report, later, () => {});
  check('E6. a later stage still masks the password in a newly dropped trace (the secret set is remembered on the report object)', report.droppedTraces?.length === 2 && !JSON.stringify(report.droppedTraces).includes(PASSWORD), JSON.stringify(report.droppedTraces?.map((x) => x.name)));
  const envSecrets = credentialSecrets({ ...loginReport(), droppedTraces: undefined }, { QA_CORE_TEST_USER: 'env-user', QA_CORE_TEST_PASS: 'env-pass' });
  check('E7. the env credential variables the run used join the secret set; an unset or empty one does not', envSecrets.has('env-user') && envSecrets.has('env-pass') && credentialSecrets(loginReport(), { QA_CORE_TEST_PASS: '' }).size === 0);
  fs.rmSync(root, { recursive: true, force: true });
}

/* ─── F. transcribe ignores the field ──────────────────────────────────── */
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-dropped-tx-'));
  const listFiles = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort();
  for (const language of ['ts', 'js'] as const) {
    const base = stageReport();
    base.language = language;
    base.reconciliation = reconcile(base);
    const withField = JSON.parse(JSON.stringify(base)) as RunReport;
    attachDroppedTraces(withField, buildStore(), () => {});
    const without = JSON.parse(JSON.stringify(base)) as RunReport;
    check(`F0. ${language}: the fixture differs only by the field`, (withField.droppedTraces?.length ?? 0) === 8 && !('droppedTraces' in without));
    const trees: string[] = [];
    for (const [label, r] of [['with', withField], ['without', without]] as const) {
      const dir = path.join(root, language, label);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'run-report.json'), JSON.stringify(r, null, 2));
      const out = runTranscribeRequest({ reportPath: path.join(language, label, 'run-report.json'), outDir: path.join(language, label, 'out') }, root);
      check(`F1. ${language} ${label}: runTranscribeRequest wrote the framework`, fs.existsSync(out.zipPath) && out.report.scenarios.length === 1);
      trees.push(path.join(dir, 'out'));
      const inline = transcribe({ report: r, outDir: path.join(dir, 'inline'), name: 'shop' });
      trees.push(path.dirname(inline.specPath));
    }
    const [aOut, aInline, bOut, bInline] = trees as [string, string, string, string];
    const aFiles = listFiles(aOut).filter((f) => !f.endsWith('.zip'));
    const bFiles = listFiles(bOut).filter((f) => !f.endsWith('.zip'));
    const differing = aFiles.filter((f) => f !== 'run-report.json' && !fs.readFileSync(path.join(aOut, f)).equals(fs.readFileSync(path.join(bOut, f))));
    check(`F2. ${language} POM: every emitted file is byte-identical with and without droppedTraces (${aFiles.length} files)`, JSON.stringify(aFiles) === JSON.stringify(bFiles) && aFiles.length > 5 && differing.length === 0, differing.join(', '));
    const zr = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'run-report.json'), 'utf8')) as RunReport;
    const aReport = zr(aOut);
    check(`F3. ${language} POM: the zipped run-report.json differs only by the redacted droppedTraces`, (aReport.droppedTraces?.length ?? 0) === 8 && JSON.stringify({ ...aReport, droppedTraces: undefined }) === JSON.stringify({ ...zr(bOut), droppedTraces: undefined }));
    const aSpecs = listFiles(aInline);
    check(`F4. ${language} single file: the inline spec is byte-identical`, JSON.stringify(aSpecs) === JSON.stringify(listFiles(bInline)) && aSpecs.every((f) => fs.readFileSync(path.join(aInline, f)).equals(fs.readFileSync(path.join(bInline, f)))));
  }
  fs.rmSync(root, { recursive: true, force: true });
}

/* ─── G. the consumers never read the field ─────────────────────────────── */
{
  const read = (f: string) => fs.readFileSync(f, 'utf8');
  const consumers = ['src/agent/transcriber.ts', 'src/agent/pom.ts', 'src/agent/scaffold.ts', 'src/agent/checkpoint.ts', 'src/agent/rule-coverage.ts', 'src/cli/transcribe.ts', 'src/agent/auth-emit.ts'];
  const readers = consumers.filter((f) => /droppedTraces/.test(read(f)));
  check('G1. the transcriber, the POM emitter, the scaffold, checkpoint, rule coverage, the transcribe CLI and auth emission never mention droppedTraces', readers.length === 0, readers.join(', '));
  const datasets = read('src/agent/datasets.ts');
  const derive = datasets.slice(datasets.indexOf('/** The dataset-relevant fills of a scenario'));
  check('G2. datasets reads the field only to redact it, never in deriving datasets', !/droppedTraces/.test(derive) && /export function credentialSecrets/.test(datasets));
  const walk = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name)).map((e) => path.join(e.parentPath, e.name));
  const serverReaders = [...walk('src/server'), ...walk('dashboard/src')].filter((f) => /droppedTraces/.test(read(f)));
  check('G3. nothing under src/server or dashboard/src reads droppedTraces (the index ignores it)', serverReaders.length === 0, serverReaders.join(', '));
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: dropped traces: every drop keeps its trace under the plan\'s canonical name (gate, critic, repair with and without an attempt, replay, stability, emitted_failed), a gap is loud, credentials are redacted in both written copies, and transcription ignores the field.');
