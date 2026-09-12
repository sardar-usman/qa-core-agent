/**
 * Locks the Phase 5 dashboard run view against a fixture run.
 *
 * Feeds the UI the exact message shapes the gateway sends (run_started, a
 * realistic event sequence, run_report, framework_zip, runs) and asserts:
 *   - the reconciliation funnel renders EXACTLY the reconciliation counts
 *     from the fixture run-report (never a UI-derived number),
 *   - verdict journeys render from review.repair (rework -> pass kept,
 *     rework -> reject dropped, rework -> not re-recorded dropped),
 *   - the cost split reads plannerUsd / usd - repairUsd / criticUsd / repairUsd,
 *   - the live panels updated from events before the report arrived,
 *   - the Resume button appears on a history card ONLY when a checkpoint
 *     exists, and Regenerate only on a completed run,
 *   - both themes render with readable contrast (dark/light screenshots are
 *     written to the scratchpad for a human look, and text colors are checked
 *     against their background luminance).
 *
 * Zero LLM, zero network.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const uiUrl = pathToFileURL(path.resolve(process.cwd(), 'qa-core-ui.html')).href;
const shotDir = process.env.QA_CORE_SMOKE_SHOTS ?? '';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

/* ─── Fixture: a run-report as the gateway forwards it (steps stripped) ─── */

const fixtureReport = {
  url: 'https://www.saucedemo.com/',
  language: 'ts',
  startedAt: '2026-09-10T10:00:00.000Z',
  finishedAt: '2026-09-10T10:04:00.000Z',
  steps: 31,
  stopped: { kind: 'cost_ceiling', reason: 'cost ceiling hit ($1.7100 against the explorer share); raise QA_CORE_COST_CEILING and resume' },
  discovery: {
    method: 'sitemap',
    pages: [
      { url: 'https://www.saucedemo.com/', source: 'sitemap' },
      { url: 'https://www.saucedemo.com/inventory.html', source: 'sitemap', feature: 'cart' },
    ],
    warnings: ['srs: no URLs stated in the document', 'user: no --urls given'],
  },
  scenarios: [
    { name: 'login succeeds with valid credentials', feature: 'login', category: 'happy', ruleIds: ['R1'], stepCount: 5 },
    { name: 'add to cart updates the badge', feature: 'cart', category: 'happy', ruleIds: ['R4'], stepCount: 6 },
    { name: 'login fails with a wrong password', feature: 'login', category: 'negative', ruleIds: ['R2'], stepCount: 5 },
  ],
  cascadeStats: { role: 8, label: 2, testid: 3, css: 1 },
  cost: { inputTokens: 90000, outputTokens: 6000, cacheReadTokens: 50000, cacheCreationTokens: 12000, usd: 1.71, plannerUsd: 0.0021, criticUsd: 0.0093, repairUsd: 0.31 },
  plan: [
    { name: 'login succeeds with valid credentials', category: 'happy', rationale: 'r', feature: 'login', ruleIds: ['R1'] },
    { name: 'add to cart updates the badge', category: 'happy', rationale: 'r', feature: 'cart', ruleIds: ['R4'] },
    { name: 'login fails with a wrong password', category: 'negative', rationale: 'r', feature: 'login', ruleIds: ['R2'] },
    { name: 'sort by price low to high', category: 'happy', rationale: 'r', feature: 'cart' },
    { name: 'remove from cart', category: 'edge', rationale: 'r', feature: 'cart' },
    { name: 'checkout with empty cart', category: 'negative', rationale: 'r', feature: 'checkout', ruleIds: ['R7'] },
    { name: 'locked out user sees an error', category: 'negative', rationale: 'r', feature: 'login', ruleIds: ['R3'] },
    { name: 'footer social links open', category: 'happy', rationale: 'r', feature: 'footer' },
  ],
  review: {
    verdicts: [
      { scenario: 'login succeeds with valid credentials', verdict: 'pass', reasons: ['asserts the inventory page'], required_fixes: [] },
      { scenario: 'add to cart updates the badge', verdict: 'pass', reasons: ['captures the badge count before and after'], required_fixes: [] },
      { scenario: 'login fails with a wrong password', verdict: 'pass', reasons: ['asserts the error text'], required_fixes: [] },
      { scenario: 'sort by price low to high', verdict: 'reject', reasons: ['compares the first cell to itself'], required_fixes: ['capture before sorting'] },
      { scenario: 'remove from cart', verdict: 'reject', reasons: ['no assertion after the removal'], required_fixes: ['assert the badge count'] },
    ],
    summary: 'Three scenarios ship with real assertions. Two rework scenarios were re-explored once; one was repaired.',
    repair: [
      { scenario: 'add to cart updates the badge', first: 'rework', second: 'pass', outcome: 'kept' },
      { scenario: 'sort by price low to high', first: 'rework', second: 'reject', outcome: 'dropped' },
      { scenario: 'remove from cart', first: 'rework', outcome: 'dropped' },
    ],
  },
  gate: { broken: [], injections: [{ scenario: 'login succeeds with valid credentials', stepIndex: 4, assertionType: 'toHaveURL', detail: 'timeout:15000ms' }] },
  replay: {
    passed: 3, failed: 1, durationMs: 9100,
    verdicts: [
      { name: 'login succeeds with valid credentials', passed: true, durationMs: 2100 },
      { name: 'add to cart updates the badge', passed: true, durationMs: 2400 },
      { name: 'login fails with a wrong password', passed: true, durationMs: 1900 },
      { name: 'locked out user sees an error', passed: false, failedStep: 3, stepKind: 'assert', error: 'expected error text not found', durationMs: 2700 },
    ],
  },
  stability: {
    iterations: 3, passed: 3, flaked: 0, flakeRate: 0, durationMs: 15000, flaky: 0, broken: 0, recovered: 1, stabilizerCostUsd: 0.004,
    verdicts: [
      { name: 'login succeeds with valid credentials', iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'PPP', durationMs: 5000 },
      { name: 'add to cart updates the badge', iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'PPP', relaxed: true, durationMs: 5000 },
      { name: 'login fails with a wrong password', iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'PPP', durationMs: 5000 },
    ],
  },
  incomplete: [{ scenario: 'checkout with empty cart', reason: 'cost ceiling hit mid-scenario' }],
  findings: [{ scenario: 'footer social links open', category: 'happy', expected: 'a new tab with twitter.com', url: 'https://www.saucedemo.com/inventory.html', messages: [] }],
  skipped: [{ scenario: 'sort by price low to high', reason: 'placeholder' }],
  reconciliation: {
    planned: 8,
    generated: 3,
    dropped: [
      { name: 'sort by price low to high', stage: 'critic', reason: 'rework -> reject' },
      { name: 'remove from cart', stage: 'critic', reason: 'rework -> not re-recorded' },
      { name: 'locked out user sees an error', stage: 'replay', reason: 'step 4 assert: expected error text not found' },
    ],
    incomplete: [{ name: 'checkout with empty cart', reason: 'cost ceiling hit mid-scenario' }],
    findings: [{ name: 'footer social links open', expected: 'a new tab with twitter.com', url: 'https://www.saucedemo.com/inventory.html', messages: [] }],
    skipped: [],
    accountedFor: 8,
    added: 0,
    balanced: true,
    stable: 2,
    recovered: 1,
    flaky: 0,
    broken: 0,
  },
  ruleCoverage: {
    covered: [{ ruleId: 'R1', scenarios: ['login succeeds with valid credentials'] }, { ruleId: 'R2', scenarios: ['login fails with a wrong password'] }, { ruleId: 'R4', scenarios: ['add to cart updates the badge'] }],
    uncovered: [{ ruleId: 'R3', text: 'A locked-out user sees a clear error', reason: 'planned-but-dropped' }, { ruleId: 'R7', text: 'Checkout is blocked on an empty cart', reason: 'planned-not-explored' }],
  },
};
// The skipped list above is deliberately empty in reconciliation and non-empty
// on the report: the funnel must read reconciliation, not re-derive from
// report.skipped. planned 8 = generated 3 + dropped 3 + incomplete 1 + findings 1 + skipped 0.

const runStarted = {
  type: 'run_started', command: 'explore',
  request: { url: 'https://www.saucedemo.com/', lang: 'ts', pom: true, features: ['login', 'cart'], srs: 'output/.uploads/srs.md', discover: false, urls: [], resume: null, stabilize: true, stabilizeAttempts: 3, env: { QA_CORE_COST_CEILING: '3' } },
  settings: [
    { name: 'QA_CORE_COST_CEILING', label: 'Cost ceiling (USD)', value: '3', fromEnv: true },
    { name: 'QA_CORE_REPAIR_RESERVE', label: 'Repair reserve (fraction)', value: '0.15', fromEnv: false },
    { name: 'QA_CORE_PLANNER_MODEL', label: 'Planner model', value: 'claude-haiku-4-5', fromEnv: false },
  ],
};

const events: Array<Record<string, unknown>> = [
  { type: 'message', text: 'Cost ceiling: $3.00 total — explorer $2.55, repair reserve $0.45 (QA_CORE_REPAIR_RESERVE)' },
  { type: 'message', text: 'discovery: srs: no URLs stated in the document' },
  { type: 'message', text: 'discovery: 5 page(s) narrowed to 2 (relevance pick)' },
  { type: 'message', text: 'discovery: 2 page(s) via sitemap' },
  { type: 'plan_started' },
  { type: 'message', text: 'Planner [1/2] https://www.saucedemo.com/: 4 scenario(s) · $0.0011' },
  { type: 'message', text: 'Planner [2/2] https://www.saucedemo.com/inventory.html: 4 scenario(s) · $0.0010' },
  { type: 'plan_done', scenarios: fixtureReport.plan, usd: 0.0021 },
  { type: 'message', text: 'Step budget: 118 (8 scenario(s), 2 fillable field(s) on the page)' },
  { type: 'tool_call', name: 'begin_scenario', input: { name: 'login succeeds with valid credentials', feature: 'login' } },
  { type: 'tool_result', name: 'begin_scenario', ok: true },
  { type: 'tool_call', name: 'fill', input: { intent: 'username', value: 'standard_user' } },
  { type: 'tool_result', name: 'fill', ok: true },
  { type: 'usage', usd: 0.42, tokens: 20000 },
  { type: 'gate_injection', scenario: 'login succeeds with valid credentials', step: 4, assertionType: 'toHaveURL', detail: 'timeout:15000ms injected' },
  { type: 'tool_call', name: 'end_scenario', input: {} },
  { type: 'tool_result', name: 'end_scenario', ok: true },
  { type: 'tool_call', name: 'skip_scenario', input: { name: 'sort by price low to high', reason: 'sort control is not rendered on this page' } },
  { type: 'tool_result', name: 'skip_scenario', ok: true },
  { type: 'usage', usd: 1.71, tokens: 96000 },
  { type: 'message', text: 'Cost ceiling reached ($1.710 > $2.55); stopping the Explorer and salvaging completed scenarios.' },
  { type: 'message', text: 'Finding: "footer social links open" — expected a new tab with twitter.com, but the page stayed at https://www.saucedemo.com/inventory.html. No visible message on the page. Recorded as a finding, not retried.' },
  { type: 'critic_started' },
  { type: 'critic_done', verdicts: [
    { scenario: 'login succeeds with valid credentials', verdict: 'pass', reasons: ['asserts the inventory page'], required_fixes: [] },
    { scenario: 'add to cart updates the badge', verdict: 'rework', reasons: ['no capture before the click'], required_fixes: ['capture the badge count first'] },
  ], usd: 0.006 },
  { type: 'message', text: 'repair pass: 3 scenario(s), budget $1.28' },
  { type: 'critic_done', verdicts: [{ scenario: 'add to cart updates the badge', verdict: 'pass', reasons: ['captures the badge count before and after'], required_fixes: [] }], usd: 0.0033 },
  { type: 'message', text: 'Repair verdict: "add to cart updates the badge" rework -> pass (kept)' },
  { type: 'message', text: 'Repair verdict: "sort by price low to high" rework -> reject (dropped)' },
  { type: 'message', text: 'Repair verdict: "remove from cart" rework -> not re-recorded (dropped)' },
  { type: 'replay_started', total: 4 },
  { type: 'replay_scenario_passed', name: 'login succeeds with valid credentials', durationMs: 2100 },
  { type: 'replay_scenario_failed', name: 'locked out user sees an error', failedStep: 3, stepKind: 'assert', error: 'expected error text not found' },
  { type: 'replay_done', passed: 3, failed: 1, durationMs: 9100 },
  { type: 'stability_started', total: 3, iterations: 3 },
  { type: 'stability_iteration_passed', name: 'login succeeds with valid credentials', iteration: 1, durationMs: 1500 },
  { type: 'stability_iteration_failed', name: 'add to cart updates the badge', iteration: 2, failedStep: 5, stepKind: 'assert', error: 'badge read 0' },
  { type: 'message', text: '  ↻ trying to recover flaky scenario: add to cart updates the badge' },
  { type: 'message', text: '    attempt 1 — Stabilizer proposed: wait — badge renders async ($0.0040)' },
  { type: 'message', text: '  ✓ recovered add to cart updates the badge — stable after 1 attempt (wait 3000ms)' },
  { type: 'stability_done', stable: 3, flaked: 0, recovered: 1, iterations: 3, flakeRate: 0, durationMs: 15000, stabilizerCostUsd: 0.004 },
];

const runReport = {
  type: 'run_report',
  report: fixtureReport,
  outcome: { kind: 'framework', reportPath: 'output/saucedemo-automation-framework/run-report.json', checkpointPath: 'output/saucedemo-automation-framework/checkpoint.json', resumeHint: 'Run stopped: cost ceiling hit. State saved. Resume with: npm run explore -- --resume output/saucedemo-automation-framework/checkpoint.json', summary: [], diagnosis: null },
};

const diskRuns = [
  {
    id: 'disk_saucedemo-automation-framework', timestamp: Date.now() - 60_000, type: 'explore', target: '/explore https://www.saucedemo.com/', host: 'www.saucedemo.com',
    scenarios: 3, passRate: null, costUsd: 2.03, spec: '', summary: fixtureReport.review.summary, verdicts: fixtureReport.review.verdicts, features: ['login', 'cart'],
    status: 'stopped', stoppedReason: fixtureReport.stopped.reason, checkpointPath: 'output/saucedemo-automation-framework/checkpoint.json',
    reportPath: 'output/saucedemo-automation-framework/run-report.json', language: 'ts', reconciliation: fixtureReport.reconciliation,
    ruleCoverage: { covered: 3, total: 5 }, findings: 1, discovery: { method: 'sitemap', pages: 2 }, repair: fixtureReport.review.repair,
  },
  {
    id: 'disk_the-internet-herokuapp-automation-framework', timestamp: Date.now() - 3_600_000, type: 'explore', target: '/explore https://the-internet.herokuapp.com/', host: 'the-internet.herokuapp.com',
    scenarios: 4, passRate: null, costUsd: 0.61, spec: '', summary: null, verdicts: null, features: ['login'],
    status: 'completed', stoppedReason: null, checkpointPath: null,
    reportPath: 'output/the-internet-herokuapp-automation-framework/run-report.json', language: 'js', reconciliation: { planned: 4, generated: 4, dropped: [], incomplete: [], findings: [], skipped: [], accountedFor: 4, added: 0, balanced: true, stable: 4, recovered: 0, flaky: 0, broken: 0 },
    ruleCoverage: null, findings: 0, discovery: null, repair: null,
  },
  {
    id: 'disk_empty-site-automation-framework', timestamp: Date.now() - 7_200_000, type: 'explore', target: '/explore https://empty.example/', host: 'empty.example',
    scenarios: 0, passRate: null, costUsd: 0.02, spec: '', summary: null, verdicts: null, features: null,
    status: 'empty', stoppedReason: null, checkpointPath: null, reportPath: 'output/empty-site-automation-framework/run-report.json', language: 'ts', reconciliation: null, ruleCoverage: null, findings: 0, discovery: null, repair: null,
  },
];

/* ─── Drive the page ─── */

// Browser-side helpers are injected as a plain script string: tsx decorates
// every inner function in a page.evaluate body with `__name`, which does not
// exist in the page (see CLAUDE.md, "tsx + page.evaluate"). The evaluate
// bodies below therefore contain no inner functions at all.
const SMOKE_HELPERS = String.raw`
window.__smoke = {
  text(root, sel) { const el = root.querySelector(sel); return (el ? el.textContent : '').replace(/\s+/g, ' ').trim(); },
  frames() { return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); },
  async live(args) {
    handleAgentMessage({ type: 'settings', settings: args.started.settings });
    handleAgentMessage(args.started);
    for (const e of args.evs) handleAgentMessage({ type: 'event', event: e });
    await this.frames();
    const rv = document.querySelector('.run-view');
    const t = (sel) => this.text(rv, sel);
    const st = (k) => { const el = rv.querySelector('[data-stage="' + k + '"]'); return el ? el.className : ''; };
    const meter = rv.querySelector('.rv-meter > i');
    return {
      badge: t('.rv-badge'), chips: t('.rv-chips'),
      discovery: t('[data-stage="discovery"] .rv-body'), plan: t('[data-stage="plan"] .rv-body'),
      explorer: t('[data-stage="explorer"] .rv-body'), critic: t('[data-stage="critic"] .rv-body'),
      replay: t('[data-stage="replay"] .rv-body'), summary: t('[data-stage="summary"] .rv-body'),
      states: { discovery: st('discovery'), plan: st('plan'), explorer: st('explorer'), critic: st('critic'), replay: st('replay') },
      meterWidth: meter ? meter.style.width : '',
    };
  },
  async final(args) {
    handleAgentMessage(args.rr);
    handleAgentMessage(args.zip);
    await this.frames();
    const rv = document.querySelector('.run-view');
    const t = (sel) => this.text(rv, sel);
    const rows = {}; const widths = {};
    rv.querySelectorAll('.funnel-row').forEach((r) => {
      const key = (r.className.match(/funnel-row (\S+)/) || [])[1] || '?';
      rows[key] = r.querySelector('.fn').textContent;
      widths[key] = r.querySelector('.fbar > i').style.width;
    });
    const labels = Array.from(rv.querySelectorAll('.rv-sub-label')).map((x) => x.textContent).join(' ');
    return {
      badge: t('.rv-badge'), rows, widths, eq: t('.funnel-eq'),
      journeys: Array.from(rv.querySelectorAll('.rv-journey')).map((j) => j.textContent.replace(/\s+/g, ' ').trim()),
      cost: t('.cost-legend') + ' ' + t('.cost-total'),
      coverage: Array.from(rv.querySelectorAll('.coverage-list')).map((l) => l.textContent.replace(/\s+/g, ' ')).join(' ') + ' ' + labels,
      findings: t('.finding'), download: t('.rv-download'),
      resumeBtn: !!rv.querySelector('[data-send^="/resume "]'),
      stopped: t('[data-stage="summary"] .rv-banner'),
      summaryState: rv.querySelector('[data-stage="summary"]').className,
      replayFinal: t('[data-stage="replay"] .rv-body'),
    };
  },
  history(runs) {
    ingestDiskRuns(runs);
    const cards = Array.from(document.querySelectorAll('#runHistory .run-card')).map((c) => ({
      id: c.dataset.id,
      status: (c.querySelector('.run-status') || {}).textContent || '',
      resume: !!c.querySelector('[data-action="resume"]'),
      regenerate: !!c.querySelector('[data-action="regenerate"]'),
      funnel: this.text(c, '.run-mini-funnel'),
      journeys: c.querySelectorAll('.rv-journey').length,
    }));
    return { cards, cmd1: resumeCommandFor('output/x/checkpoint.json', '4'), cmd2: resumeCommandFor('output/x/checkpoint.json', '') };
  },
  replaced(run) {
    ingestDiskRuns([Object.assign({}, run, { status: 'completed', checkpointPath: null, scenarios: 8 })]);
    const cards = Array.from(document.querySelectorAll('#runHistory .run-card')).filter((c) => c.dataset.id === run.id);
    return { count: cards.length, resume: !!(cards[0] && cards[0].querySelector('[data-action="resume"]')), regenerate: !!(cards[0] && cards[0].querySelector('[data-action="regenerate"]')) };
  },
  contrast() {
    const lum = (rgb) => {
      const m = (rgb.match(/\d+(\.\d+)?/g) || ['0', '0', '0']).slice(0, 3).map((v) => { const c = Number(v) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
      return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
    };
    const ratio = (fg, bg) => { const a = lum(fg); const b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
    const bg = getComputedStyle(document.querySelector('.rv-stage')).backgroundColor;
    const out = {};
    for (const s of ['.rv-stage-name', '.rv-body', '.funnel-row .fn', '.rv-journey .name', '.cost-legend', '.rv-chip', '.run-card-title']) {
      const el = document.querySelector(s);
      if (el) out[s] = Math.round(ratio(getComputedStyle(el).color, bg) * 10) / 10;
    }
    return out;
  },
  async stream(args) {
    // The real entry point for every gateway payload, with the console-style
    // {text} lines interleaved exactly as the gateway sends them.
    handleGatewayPayload({ type: 'settings', settings: args.started.settings });
    // A parse note arrives BEFORE run_started and is ordinary chat.
    const chatBefore = document.querySelectorAll('.msg.agent').length;
    handleGatewayPayload({ text: 'Note: Stabilizer will try up to 3 fix attempts per flaky scenario.' });
    const preRunNote = document.querySelectorAll('.msg.agent').length - chatBefore;
    handleGatewayPayload(args.started);
    const bubblesBefore = document.querySelectorAll('.msg.agent').length;
    handleGatewayPayload({ text: '▸ Exploring https://www.saucedemo.com/' });
    handleGatewayPayload({ text: '  features: login, cart' });
    let i = 0;
    for (const e of args.evs) {
      handleGatewayPayload({ type: 'event', event: e });
      if (e.type === 'message') handleGatewayPayload({ text: e.text });
      if (++i === 5) handleGatewayPayload({ text: 'Step budget: 118 (8 scenario(s), 2 fillable field(s) on the page)' });
    }
    await this.frames();
    const rv = document.querySelector('.run-view');
    const bubblesDuring = document.querySelectorAll('.msg.agent').length - bubblesBefore;
    const logSummary = this.text(rv, '.rv-log > summary');
    const logLines = rv.querySelectorAll('.rv-log-lines > div').length;
    const badge = this.text(rv, '.rv-badge');
    const explorer = this.text(rv, '[data-stage="explorer"] .rv-body');
    handleGatewayPayload(args.rr);
    handleGatewayPayload({ text: '**Done.** Wrote framework to output/saucedemo-automation-framework (3 scenarios, 17 files).' });
    handleGatewayPayload(args.zip);
    await this.frames();
    const bubblesAfter = document.querySelectorAll('.msg.agent').length - bubblesBefore;
    const runViews = document.querySelectorAll('.run-view').length;
    return { preRunNote, bubblesDuring, bubblesAfter, logSummary, logLines, badge, explorer, runViews, logOpen: rv.querySelector('.rv-log').open,
      doneBubble: Array.from(document.querySelectorAll('.msg.agent .msg-bubble')).some((b) => /Done\./.test(b.textContent)) };
  },
  stale() {
    const before = document.querySelectorAll('.msg.agent').length;
    handleGatewayPayload({ text: '▸ Exploring https://old.example/' });
    const bubbles = Array.from(document.querySelectorAll('.msg.agent .msg-bubble')).slice(before).map((b) => b.textContent);
    return { added: bubbles.length, note: bubbles.some((t) => /older build|npm run gateway/.test(t)), toast: (document.getElementById('toast') || {}).textContent || '' };
  },
  async historyView(args) {
    handleGatewayPayload({ type: 'run_report', fromHistory: true, report: args.report, outcome: args.outcome });
    await this.frames();
    const views = document.querySelectorAll('.run-view');
    const rv = views[views.length - 1];
    const rows = {};
    rv.querySelectorAll('.funnel-row').forEach((r) => { rows[(r.className.match(/funnel-row (\S+)/) || [])[1] || '?'] = r.querySelector('.fn').textContent; });
    const st = (k) => rv.querySelector('[data-stage="' + k + '"]').className;
    return {
      fromHistory: rv.classList.contains('from-history'), badge: this.text(rv, '.rv-badge'), rows,
      journeys: rv.querySelectorAll('.rv-journey').length, hasLog: !!rv.querySelector('.rv-log'),
      states: { discovery: st('discovery'), plan: st('plan'), explorer: st('explorer'), critic: st('critic'), replay: st('replay'), summary: st('summary') },
      plan: this.text(rv, '[data-stage="plan"] .rv-body'), replay: this.text(rv, '[data-stage="replay"] .rv-body'),
      resumeBtn: !!rv.querySelector('[data-send^="/resume "]'),
    };
  },
  scrollTop() { document.getElementById('messages').scrollTop = 0; },
  scrollEnd() { const rv = document.querySelector('.run-view'); if (rv) rv.scrollIntoView({ block: 'end' }); },
};
`;

const browser = await chromium.launch({ headless: true });

async function runIn(theme: 'dark' | 'light'): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1480, height: 1100 }, colorScheme: theme });
  const page = await context.newPage();
  const jsErrors: string[] = [];
  page.on('pageerror', (e) => jsErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console.error: ' + m.text()); });
  // Seed the theme choice and an empty history before the page's own scripts run.
  await context.addInitScript((t) => { localStorage.removeItem('qa-core.runs.v1'); localStorage.setItem('qa-core.theme', t); }, theme);
  await page.goto(uiUrl, { waitUntil: 'load' });
  await page.addScriptTag({ content: SMOKE_HELPERS });
  await page.waitForTimeout(300);

  check(`${theme}: page applies data-theme`, await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === theme);

  // Live phase: run_started + events, before any report.
  // @ts-expect-error __smoke is injected above
  const live = await page.evaluate((args) => window.__smoke.live(args), { started: runStarted, evs: events }) as {
    badge: string; chips: string; discovery: string; plan: string; explorer: string; critic: string; replay: string; summary: string;
    states: { discovery: string; plan: string; explorer: string; critic: string; replay: string }; meterWidth: string;
  };

  check(`${theme}: run view badge is running before the report`, live.badge === 'running', live.badge);
  check(`${theme}: header chips show the per-run ceiling override ($3) and srs`, /cost ceiling \$3/.test(live.chips) && /srs srs\.md/.test(live.chips), live.chips);
  check(`${theme}: discovery panel shows rung, page count and the filter result`, /rung sitemap/.test(live.discovery) && /pages 2/.test(live.discovery) && /filter 5 → 2/.test(live.discovery), live.discovery);
  check(`${theme}: discovery panel lists the warning`, /no URLs stated/.test(live.discovery), live.discovery);
  check(`${theme}: plan panel lists per-page planner lines with cost`, /\[1\/2\].*4 scenario\(s\) · \$0\.0011/.test(live.plan) && /\[2\/2\]/.test(live.plan), live.plan);
  check(`${theme}: plan panel shows scenario count and tags`, /scenarios 8/.test(live.plan) && /R1/.test(live.plan) && /negative/.test(live.plan), live.plan);
  check(`${theme}: explorer panel shows step budget from the runtime line (4 tool calls / 118)`, /steps 4 \/ 118/.test(live.explorer), live.explorer);
  check(`${theme}: explorer cost meter reads usage against the explorer sub-ceiling`, /explorer \$1\.7100/.test(live.explorer) && /sub-ceiling \$2\.55/.test(live.explorer), live.explorer);
  check(`${theme}: explorer meter width is usd / sub-ceiling`, live.meterWidth === '67.1%', live.meterWidth);
  check(`${theme}: explorer panel lists the skip with its reason`, /skipped.*sort by price low to high.*sort control is not rendered/.test(live.explorer), live.explorer);
  check(`${theme}: explorer panel shows gate injection count and the stop line`, /gate injections 1/.test(live.explorer) && /Cost ceiling reached/.test(live.explorer), live.explorer);
  check(`${theme}: critic panel shows repair banner with count and budget`, /repair pass 3 scenario\(s\) re-explored · budget \$1\.28/.test(live.critic), live.critic);
  check(`${theme}: critic panel shows live verdict journeys`, /rework → pass kept/.test(live.critic) && /rework → reject dropped/.test(live.critic) && /rework → not re-recorded dropped/.test(live.critic), live.critic);
  check(`${theme}: replay panel shows pass/fail and the failed step`, /login succeeds/.test(live.replay) && /locked out user.*step 4 assert/.test(live.replay), live.replay);
  check(`${theme}: stability shows the stabilizer attempt and recovery`, /recovered.*add to cart updates the badge.*#1 wait/.test(live.replay), live.replay);
  check(`${theme}: summary shows cost so far from events only`, /cost so far \$1\.7214/.test(live.summary), live.summary);
  check(`${theme}: stage states progressed (discovery, plan, explorer, critic, replay all done)`, /done/.test(live.states.discovery) && /done/.test(live.states.plan) && /done/.test(live.states.explorer) && /done/.test(live.states.critic) && /done/.test(live.states.replay), JSON.stringify(live.states));

  // Final phase: run_report + framework_zip.
  const zipMsg = { type: 'framework_zip', filename: 'saucedemo-automation-framework.zip', base64: 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', sizeBytes: 22, fileCount: 17, scenarios: 3, runReportPath: 'output/saucedemo-automation-framework/run-report.json' };
  // @ts-expect-error __smoke is injected above
  const final = await page.evaluate((args) => window.__smoke.final(args), { rr: runReport, zip: zipMsg }) as { badge: string; rows: Record<string, string>; widths: Record<string, string>; eq: string; journeys: string[]; cost: string; coverage: string; findings: string; download: string; resumeBtn: boolean; stopped: string; summaryState: string; replayFinal: string };

  const rec = fixtureReport.reconciliation;
  check(`${theme}: badge reads stopped for a report with stopped set`, final.badge === 'stopped', final.badge);
  check(`${theme}: funnel planned equals reconciliation.planned`, final.rows.planned === String(rec.planned), JSON.stringify(final.rows));
  check(`${theme}: funnel generated equals reconciliation.generated`, final.rows.generated === String(rec.generated));
  check(`${theme}: funnel dropped equals reconciliation.dropped.length`, final.rows.dropped === String(rec.dropped.length));
  check(`${theme}: funnel incomplete equals reconciliation.incomplete.length`, final.rows.incomplete === String(rec.incomplete.length));
  check(`${theme}: funnel findings equals reconciliation.findings.length`, final.rows.findings === String(rec.findings.length));
  check(`${theme}: funnel skipped equals reconciliation.skipped.length (0), not report.skipped (1)`, final.rows.skipped === '0', final.rows.skipped);
  check(`${theme}: funnel identity line matches the CLI numbers`, /8 = 3 \+ 3 \+ 1 \+ 1 \+ 0/.test(final.eq) && /balanced/.test(final.eq), final.eq);
  check(`${theme}: funnel bar widths are proportional to planned`, parseFloat(final.widths.generated ?? '') === 37.5 && parseFloat(final.widths.planned ?? '') === 100 && parseFloat(final.widths.incomplete ?? '') === 12.5, JSON.stringify(final.widths));
  check(`${theme}: verdict journeys render from review.repair (3 rows)`, final.journeys.length === 3, JSON.stringify(final.journeys));
  check(`${theme}: journey rework -> pass reads kept`, /add to cart.*rework → pass kept/.test(final.journeys[0] ?? ''));
  check(`${theme}: journey rework -> reject reads dropped`, /sort by price.*rework → reject dropped/.test(final.journeys[1] ?? ''));
  check(`${theme}: journey rework -> not re-recorded reads dropped`, /remove from cart.*rework → not re-recorded dropped/.test(final.journeys[2] ?? ''));
  check(`${theme}: cost split reads planner / explorer minus repair / critic / repair from the report`, /planner \$0\.0021/.test(final.cost) && /explorer \$1\.4000/.test(final.cost) && /critic \$0\.0093/.test(final.cost) && /repair \$0\.3100/.test(final.cost) && /stabilizer \$0\.0040/.test(final.cost), final.cost);
  check(`${theme}: cost total is the sum of the report's cost fields`, /\$1\.7254 total/.test(final.cost), final.cost);
  check(`${theme}: rule coverage shows covered count and considered-not-automated with reasons`, /3 of 5 covered/.test(final.coverage) && /R3/.test(final.coverage) && /planned-but-dropped/.test(final.coverage) && /planned-not-explored/.test(final.coverage), final.coverage);
  check(`${theme}: findings are called out separately with the real URL`, /footer social links open/.test(final.findings) && /inventory\.html/.test(final.findings), final.findings);
  check(`${theme}: summary carries the zip download`, /saucedemo-automation-framework\.zip/.test(final.download) && /3 scenarios · 17 files/.test(final.download), final.download);
  check(`${theme}: summary offers Resume when the outcome kept a checkpoint`, final.resumeBtn);
  check(`${theme}: stopped banner names the reason`, /stopped early.*cost ceiling hit/.test(final.stopped), final.stopped);
  check(`${theme}: summary stage is done`, /done/.test(final.summaryState), final.summaryState);
  check(`${theme}: replay panel switches to report data (recovered pattern)`, /recovered/.test(final.replayFinal) && /PPP/.test(final.replayFinal), final.replayFinal);

  // Run history: resume only with a checkpoint, regenerate only when completed.
  // @ts-expect-error __smoke is injected above
  const history = await page.evaluate((runs) => window.__smoke.history(runs), diskRuns) as { cards: Array<{ id: string; status: string; resume: boolean; regenerate: boolean; funnel: string; journeys: number }>; cmd1: string; cmd2: string };
  const stoppedCard = history.cards.find((c) => c.id === 'disk_saucedemo-automation-framework');
  const doneCard = history.cards.find((c) => c.id === 'disk_the-internet-herokuapp-automation-framework');
  const emptyCard = history.cards.find((c) => c.id === 'disk_empty-site-automation-framework');
  check(`${theme}: stopped run shows a Resume button and no Regenerate`, !!stoppedCard && stoppedCard.resume && !stoppedCard.regenerate, JSON.stringify(stoppedCard));
  check(`${theme}: stopped run status badge names the checkpoint`, /stopped · checkpoint/.test(stoppedCard?.status ?? ''), stoppedCard?.status);
  check(`${theme}: completed run shows Regenerate and no Resume`, !!doneCard && doneCard.regenerate && !doneCard.resume, JSON.stringify(doneCard));
  check(`${theme}: empty run shows neither`, !!emptyCard && !emptyCard.resume && !emptyCard.regenerate, JSON.stringify(emptyCard));
  check(`${theme}: history card mini-funnel repeats the reconciliation counts`, /planned 8.*generated 3.*dropped 3.*incomplete 1.*findings 1.*skipped 0.*rules 3\/5/.test(stoppedCard?.funnel ?? ''), stoppedCard?.funnel);
  check(`${theme}: history card renders the verdict journeys`, stoppedCard?.journeys === 3, String(stoppedCard?.journeys));
  check(`${theme}: resume command carries the optional ceiling`, history.cmd1 === '/resume output/x/checkpoint.json --ceiling 4' && history.cmd2 === '/resume output/x/checkpoint.json', history.cmd1 + ' | ' + history.cmd2);

  // A resumed disk run replaces its stale record instead of duplicating it.
  // @ts-expect-error __smoke is injected above
  const replaced = await page.evaluate((run) => window.__smoke.replaced(run), diskRuns[0]) as { count: number; resume: boolean; regenerate: boolean };
  check(`${theme}: a disk run that completed after a resume replaces its stopped record`, replaced.count === 1 && !replaced.resume && replaced.regenerate, JSON.stringify(replaced));

  // Contrast: sample the key text colors against the panel background.
  // @ts-expect-error __smoke is injected above
  const contrast = await page.evaluate(() => window.__smoke.contrast()) as Record<string, number>;
  const weakest = Math.min(...Object.values(contrast));
  check(`${theme}: run view text keeps at least 4.5:1 contrast against the panel`, weakest >= 4.5, JSON.stringify(contrast));

  // ─── Live stream through the real payload entry point, text lines included ───
  await page.evaluate(() => { document.querySelectorAll('.run-view').forEach((el) => el.remove()); });
  // @ts-expect-error __smoke is injected above
  const streamed = await page.evaluate((args) => window.__smoke.stream(args), { started: runStarted, evs: events, rr: runReport, zip: zipMsg }) as { preRunNote: number; bubblesDuring: number; bubblesAfter: number; logSummary: string; logLines: number; badge: string; explorer: string; runViews: number; logOpen: boolean; doneBubble: boolean };
  check(`${theme}: live stream: a note before run_started is ordinary chat`, streamed.preRunNote === 1, String(streamed.preRunNote));
  check(`${theme}: live stream: no chat bubbles are added while the run is live (console lines go to the run log)`, streamed.bubblesDuring === 0, String(streamed.bubblesDuring));
  check(`${theme}: live stream: the run view exists and reads running`, streamed.runViews === 1 && streamed.badge === 'running', streamed.badge);
  check(`${theme}: live stream: the console log is collapsed and counts every text line`, !streamed.logOpen && /console log 19 lines/.test(streamed.logSummary) && streamed.logLines === 19, streamed.logSummary + ' / ' + streamed.logLines);
  check(`${theme}: live stream: panels update from events, not from the text lines`, /steps 4 \/ 118/.test(streamed.explorer) && /Cost ceiling reached/.test(streamed.explorer), streamed.explorer);
  check(`${theme}: live stream: after run_report the Done summary is a chat bubble again`, streamed.bubblesAfter >= 1 && streamed.doneBubble, String(streamed.bubblesAfter));

  // ─── An older gateway build (no run_started) is called out ───
  // @ts-expect-error __smoke is injected above
  const stale = await page.evaluate(() => window.__smoke.stale()) as { added: number; note: boolean; toast: string };
  check(`${theme}: a "▸ Exploring" line with no live run view adds an older-build note and a toast`, stale.note && /older build/.test(stale.toast), JSON.stringify(stale));

  // ─── Opening a run from history renders the same panels from the report ───
  // @ts-expect-error __smoke is injected above
  const hist = await page.evaluate((args) => window.__smoke.historyView(args), { report: fixtureReport, outcome: { kind: 'framework', reportPath: 'output/saucedemo-automation-framework/run-report.json', checkpointPath: 'output/saucedemo-automation-framework/checkpoint.json', resumeHint: null, summary: [], diagnosis: null } }) as { fromHistory: boolean; badge: string; rows: Record<string, string>; journeys: number; hasLog: boolean; states: Record<string, string>; plan: string; replay: string; resumeBtn: boolean };
  check(`${theme}: history view: a from-history run view opens with the stopped badge`, hist.fromHistory && hist.badge === 'stopped', JSON.stringify({ f: hist.fromHistory, b: hist.badge }));
  check(`${theme}: history view: funnel counts equal the reconciliation arrays`, hist.rows.planned === '8' && hist.rows.generated === '3' && hist.rows.dropped === '3' && hist.rows.incomplete === '1' && hist.rows.findings === '1' && hist.rows.skipped === '0', JSON.stringify(hist.rows));
  check(`${theme}: history view: journeys, plan and replay panels render from the report`, hist.journeys === 3 && /scenarios 8/.test(hist.plan) && /PPP/.test(hist.replay), JSON.stringify({ j: hist.journeys, p: hist.plan.slice(0, 40), r: hist.replay.slice(0, 60) }));
  check(`${theme}: history view: every stage reads done and there is no console log`, Object.values(hist.states).every((c) => /done/.test(c)) && !hist.hasLog, JSON.stringify(hist.states));
  check(`${theme}: history view: resume offered because the report dir has a checkpoint`, hist.resumeBtn);
  const viewBtn = await page.evaluate(() => document.querySelectorAll('#runHistory [data-action="view"]').length);
  check(`${theme}: every history card with a report offers a view action`, viewBtn === 3, String(viewBtn));
  const headerSub = await page.evaluate(() => (document.querySelector('.chat-header .sub') || {}).textContent || '');
  check(`${theme}: header reads "Powered by Claude." only`, headerSub.trim() === 'Powered by Claude.', headerSub);

  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true });
    // @ts-expect-error __smoke is injected above
    await page.evaluate(() => window.__smoke.scrollTop());
    await page.screenshot({ path: path.join(shotDir, `run-view-${theme}.png`), fullPage: false });
    await page.locator('.run-view .rv-log').first().evaluate((d) => { (d as HTMLDetailsElement).open = true; });
    await page.locator('.run-view .rv-log').first().screenshot({ path: path.join(shotDir, `run-log-${theme}.png`) });
    for (const stage of ['explorer', 'critic', 'replay', 'summary']) {
      await page.locator(`.run-view [data-stage="${stage}"]`).first().screenshot({ path: path.join(shotDir, `stage-${stage}-${theme}.png`) });
    }
  }

  check(`${theme}: zero console errors`, jsErrors.length === 0, jsErrors.join(' | '));
  await context.close();
}

await runIn('dark');
await runIn('light');
await browser.close();

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: dashboard run view renders funnel, verdict journeys, cost split and coverage from the run-report; history offers Resume only with a checkpoint.');
