/**
 * Locks the Run Detail endpoint and page (dashboard v2 plan, PR B):
 *   - a seeded v2 run (3 scenarios: pass shipped, rework repaired and shipped,
 *     reject dropped; 1 finding; events.jsonl) returns exactly those verdicts,
 *     shipped 2 as stored, findings length 1, artifacts present on disk only
 *   - the finding is never a scenario row
 *   - a run id that does not exist is a 404 whose message names the path
 *   - an indexed run whose run-report vanished is a 404 naming that path
 *   - a legacy record returns legacy: true, summary fields, no scenarios key
 *   - artifacts are served only from the run's own directory
 *   - the rendered page shows the finding under "Product behavior to review"
 *     and not in the scenarios table, the verdict badges, "No findings
 *     recorded" for a run without findings, the legacy notice, the back link
 * The API section runs on an ephemeral http server; the page section boots a
 * real gateway on a spare port with the built dashboard. No model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { openDatabase } from '../src/server/db/migrate.js';
import { indexOutput } from '../src/server/db/indexer.js';
import { createApiHandler } from '../src/server/api.js';
import { buildRunDetail } from '../src/server/run-detail.js';
import { newRunId } from '../src/agent/output-layout.js';
import { appendRunEvent } from '../src/server/events.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

/* ─── fixture: one v2 run, one run without findings, one legacy record ─── */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-detail-'));
const output = path.join(root, 'output');
const runId = newRunId(new Date('2026-09-14T10:00:00Z'), 'detail');
const runDir = path.join(output, 'saucedemo-com', runId);
fs.mkdirSync(runDir, { recursive: true });
const step = (url: string) => ({ kind: 'navigate', url });
const report = {
  url: 'https://www.saucedemo.com/', language: 'ts', startedAt: '2026-09-14T10:00:00.000Z', finishedAt: '2026-09-14T10:04:14.000Z', steps: 31,
  // A multi-page run: the sitemap rung produced two pages, robots dropped one.
  discovery: {
    method: 'sitemap',
    pages: [{ url: 'https://www.saucedemo.com/', source: 'sitemap' }, { url: 'https://www.saucedemo.com/inventory.html', source: 'sitemap', feature: 'cart' }],
    warnings: ['robots.txt disallows /checkout-complete.html; dropped from the sitemap set'],
  },
  gate: { broken: [], injections: [{ scenario: 'login succeeds with valid credentials', stepIndex: 3, assertionType: 'toBeVisible', detail: 'RULE 2: timeout 5000 injected' }] },
  heals: [{ scenario: 'add to cart updates the badge', intent: 'add to cart button', from: 'button#add-to-cart-sauce-labs-backpack', to: 'getByRole("button", { name: "Add to cart" })' }],
  skipped: [{ scenario: 'footer twitter link opens a new tab', reason: 'opens an external site, out of scope' }],
  // Emitted (shipped): the pass and the repaired rework. The reject and the finding are not here.
  scenarios: [
    { name: 'login succeeds with valid credentials', feature: 'login', category: 'happy', steps: [step('https://www.saucedemo.com/')] },
    { name: 'add to cart updates the badge', feature: 'cart', category: 'happy', steps: [step('https://www.saucedemo.com/')] },
  ],
  cascadeStats: {}, cost: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 1.4, plannerUsd: 0.0021, criticUsd: 0.0093, repairUsd: 0.31 },
  plan: [
    { name: 'login succeeds with valid credentials', category: 'happy', rationale: 'r', feature: 'login', ruleIds: ['R1'], pageUrl: 'https://www.saucedemo.com/' },
    { name: 'add to cart updates the badge', category: 'happy', rationale: 'r', feature: 'cart', pageUrl: 'https://www.saucedemo.com/inventory.html' },
    { name: 'sort by price low to high', category: 'happy', rationale: 'r', feature: 'cart', pageUrl: 'https://www.saucedemo.com/inventory.html' },
    { name: 'footer social links open', category: 'happy', rationale: 'r', feature: 'footer', pageUrl: 'https://www.saucedemo.com/inventory.html' },
    { name: 'footer twitter link opens a new tab', category: 'edge', rationale: 'r', feature: 'footer', pageUrl: 'https://www.saucedemo.com/inventory.html' },
  ],
  // Verdict names carry the "N. [category] " prefix the live Critic echoes back,
  // and two are small rephrasings of the plan names. The fourth matches no
  // scenario at all: it must surface as an unmatched verdict, never as a row.
  review: {
    verdicts: [
      { scenario: '1. [happy] login succeeds with valid credentials', verdict: 'pass', reasons: ['asserts the inventory page'], required_fixes: [] },
      { scenario: '2. [happy] add to cart updates the badge count', verdict: 'pass', reasons: ['captures the badge count before and after'], required_fixes: [] },
      { scenario: '3. [happy] sort by price low to high ascending', verdict: 'reject', reasons: ['compares the first cell to itself'], required_fixes: ['capture before sorting'] },
      { scenario: '5. [negative] checkout with an empty cart shows an error', verdict: 'rework', reasons: ['no such scenario was planned'], required_fixes: [] },
      // Matches the finding's name: attached to the finding card, never a row, never discarded.
      { scenario: '4. [happy] footer social links open', verdict: 'reject', reasons: ['asserts a redirect the page never produced'], required_fixes: ['assert the visible outcome'] },
    ],
    summary: 'Two scenarios ship; one was repaired.',
    repair: [
      { scenario: '[happy] add to cart updates the badge', first: 'rework', second: 'pass', outcome: 'kept' },
      { scenario: 'sort by price low to high', first: 'rework', second: 'reject', outcome: 'dropped' },
    ],
  },
  replay: { passed: 2, failed: 0, durationMs: 5000, verdicts: [
    { name: 'login succeeds with valid credentials', passed: true, durationMs: 2000 },
    { name: 'add to cart updates the badge', passed: true, durationMs: 2500 },
  ] },
  stability: { iterations: 3, passed: 2, flaked: 0, flakeRate: 0, durationMs: 9000, recovered: 1, stabilizerCostUsd: 0.004, verdicts: [
    { name: 'login succeeds with valid credentials', iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'PPP', durationMs: 4000 },
    { name: 'add to cart updates the badge', iterations: 3, passes: 2, stable: true, classification: 'stable', pattern: 'PFP', relaxed: true, durationMs: 5000 },
  ] },
  findings: [{ scenario: 'footer social links open', category: 'happy', expected: 'a new tab with twitter.com', url: 'https://www.saucedemo.com/inventory.html', messages: [] }],
  reconciliation: {
    planned: 5, generated: 2, dropped: [{ name: 'sort by price low to high', stage: 'critic', reason: 'rework -> reject' }], incomplete: [],
    findings: [{ name: 'footer social links open', expected: 'a new tab with twitter.com', url: 'https://www.saucedemo.com/inventory.html', messages: [] }],
    skipped: [{ name: 'footer twitter link opens a new tab', reason: 'opens an external site, out of scope' }],
    accountedFor: 5, added: 0, balanced: true, stable: 1, recovered: 1, flaky: 0, broken: 0,
  },
  ruleCoverage: { covered: [{ ruleId: 'R1', scenarios: ['login succeeds with valid credentials'] }], uncovered: [{ ruleId: 'R2', text: 'Lockout after 5 failed logins', reason: 'not-planned' }] },
};
fs.writeFileSync(path.join(runDir, 'run-report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(runDir, 'saucedemo-automation-framework.zip'), 'PKzip');
fs.writeFileSync(path.join(runDir, 'rule-coverage.json'), JSON.stringify(report.ruleCoverage));
fs.writeFileSync(path.join(runDir, 'landing.png'), 'not really a png');
fs.writeFileSync(path.join(runDir, 'run-meta.json'), JSON.stringify({ source: 'dashboard', flags: {}, writtenAt: 'x' }));
appendRunEvent(runDir, { type: 'plan_started' }, new Date('2026-09-14T10:00:05Z'));
appendRunEvent(runDir, { type: 'plan_done', scenarios: report.plan as never, usd: 0.0021 }, new Date('2026-09-14T10:00:09Z'));
appendRunEvent(runDir, { type: 'thinking_started' }, new Date('2026-09-14T10:00:10Z'));
appendRunEvent(runDir, { type: 'tool_call', name: 'begin_scenario', input: { name: 'login succeeds with valid credentials' } }, new Date('2026-09-14T10:00:11Z'));
appendRunEvent(runDir, { type: 'critic_done', verdicts: report.review.verdicts as never, usd: 0.0093 }, new Date('2026-09-14T10:03:00Z'));
appendRunEvent(runDir, { type: 'done', scenarios: 2 }, new Date('2026-09-14T10:04:14Z'));
// A second run with no findings.
const quietId = newRunId(new Date('2026-09-13T10:00:00Z'), 'quiet');
const quietDir = path.join(output, 'saucedemo-com', quietId);
fs.mkdirSync(quietDir, { recursive: true });
fs.writeFileSync(path.join(quietDir, 'run-report.json'), JSON.stringify({ ...report, discovery: undefined, heals: undefined, skipped: [], startedAt: '2026-09-13T10:00:00.000Z', finishedAt: '2026-09-13T10:02:00.000Z', findings: [], plan: report.plan.slice(0, 3), review: { ...report.review, verdicts: report.review.verdicts.slice(0, 3) }, reconciliation: { ...report.reconciliation, planned: 3, findings: [], skipped: [] } }));
// A run with an events.jsonl that exists but holds nothing.
const emptyId = newRunId(new Date('2026-09-11T10:00:00Z'), 'empty0');
const emptyDir = path.join(output, 'saucedemo-com', emptyId);
fs.mkdirSync(emptyDir, { recursive: true });
// Same run without the unmatched verdict: findings and an uncovered rule remain, so Summary is 'attention', not 'warning'.
fs.writeFileSync(path.join(emptyDir, 'run-report.json'), JSON.stringify({ ...report, review: { ...report.review, verdicts: report.review.verdicts.filter((v) => !/checkout/.test(v.scenario)) }, startedAt: '2026-09-11T10:00:00.000Z', finishedAt: '2026-09-11T10:02:00.000Z' }));
fs.writeFileSync(path.join(emptyDir, 'events.jsonl'), '');
// A run whose report vanishes after indexing.
const goneId = newRunId(new Date('2026-09-12T10:00:00Z'), 'gone');
fs.mkdirSync(path.join(output, 'saucedemo-com', goneId), { recursive: true });
fs.writeFileSync(path.join(output, 'saucedemo-com', goneId, 'run-report.json'), JSON.stringify({ ...report, findings: [] }));
// A legacy record.
fs.mkdirSync(path.join(root, '.qa-core', 'sites'), { recursive: true });
fs.writeFileSync(path.join(root, '.qa-core', 'sites', 'demoqa.com.json'), JSON.stringify({ host: 'demoqa.com', recentRuns: [{ at: '2026-06-30T15:53:33.479Z', url: 'https://demoqa.com/frames', scenarios: 1, cost: 0.627841, model: 'claude-opus-4-7', durationSec: 255 }] }));
fs.writeFileSync(path.join(root, 'secret.txt'), 'nope');

/* ─── endpoint ─── */
const db = openDatabase(path.join(root, 'data', 'qa-core.sqlite'));
indexOutput(db, root);
fs.rmSync(path.join(output, 'saucedemo-com', goneId, 'run-report.json'));

const d = buildRunDetail(db, root, runId);
check('A. the seeded run resolves with status 200 and legacy: false', d.status === 200 && d.body.legacy === false);
if (d.status === 200 && d.body.legacy === false) {
  const b = d.body;
  const byName = new Map(b.scenarios.map((s) => [s.name, s]));
  check('B. exactly the four planned non-finding scenarios are rows (three explored, one skipped); the finding is not one', b.scenarios.length === 4 && !byName.has('footer social links open') && byName.get('footer twitter link opens a new tab')?.skipped_reason === 'opens an external site, out of scope', JSON.stringify(b.scenarios.map((s) => s.name)));
  check('C. verdicts attach through the tolerant matcher (prefix stripped, rephrasing tolerated): pass / pass / reject, none null', byName.get('login succeeds with valid credentials')?.verdict === 'pass' && byName.get('add to cart updates the badge')?.verdict === 'pass' && byName.get('sort by price low to high')?.verdict === 'reject' && b.scenarios.every((s) => s.verdict !== null || s.skipped_reason !== null), JSON.stringify(b.scenarios.map((s) => [s.name, s.verdict])));
  check('C2. the verdict that matches no scenario lands in unmatched_verdicts and is never a scenario row', b.unmatched_verdicts.length === 1 && b.unmatched_verdicts[0]?.scenario === '5. [negative] checkout with an empty cart shows an error' && b.unmatched_verdicts[0]?.verdict === 'rework' && !b.scenarios.some((s) => /checkout/.test(s.name)) && !b.scenarios.some((s) => s.replay === null && s.shipped === false && s.verdict === null && s.skipped_reason === null), JSON.stringify(b.unmatched_verdicts));
  check('C3. the verdict that matched the finding name is attached to the finding, not discarded and not unmatched', b.findings[0]?.verdict?.verdict === 'reject' && b.findings[0]?.verdict?.reasons[0] === 'asserts a redirect the page never produced' && !b.unmatched_verdicts.some((v) => /footer social/.test(v.scenario)), JSON.stringify(b.findings));
  check('D. repair status: none / repaired (rework -> pass, kept) / failed (rework -> reject, dropped)', byName.get('login succeeds with valid credentials')?.repair === 'none' && byName.get('add to cart updates the badge')?.repair === 'repaired' && byName.get('sort by price low to high')?.repair === 'failed' && byName.get('sort by price low to high')?.repair_second === 'reject');
  check('E. shipped yes/no is the emitted list: 2 shipped, the reject not', byName.get('login succeeds with valid credentials')?.shipped === true && byName.get('add to cart updates the badge')?.shipped === true && byName.get('sort by price low to high')?.shipped === false && b.counts.shipped === 2);
  check('F. replay and stability are the recorded outcomes, per-attempt pattern included', byName.get('add to cart updates the badge')?.replay === 'pass' && byName.get('add to cart updates the badge')?.stability?.passes === 2 && byName.get('add to cart updates the badge')?.stability?.iterations === 3 && byName.get('add to cart updates the badge')?.stability?.pattern === 'PFP' && byName.get('add to cart updates the badge')?.stability?.recovered === true && byName.get('sort by price low to high')?.replay === null && byName.get('sort by price low to high')?.stability === null);
  check('G. the reject carries where it was dropped, from the reconciliation', byName.get('sort by price low to high')?.dropped_at === 'critic' && byName.get('sort by price low to high')?.dropped_reason === 'rework -> reject');
  check('H. findings length 1 with expected, url and messages as stored', b.findings.length === 1 && b.findings[0]?.scenario === 'footer social links open' && b.findings[0]?.expected === 'a new tab with twitter.com' && b.counts.findings === 1);
  check('I. header: host, run id, timing, status, cost split from the index row, stabilizer cost from the report', b.header.host === 'saucedemo.com' && b.header.run_id === runId && b.header.started_at === report.startedAt && b.header.ended_at === report.finishedAt && b.header.status === 'completed' && Math.abs(b.header.cost.total - 1.4154) < 1e-9 && Math.abs(b.header.cost.repair - 0.31) < 1e-9 && b.header.cost.stabilizer === 0.004 && b.header.environment === null, JSON.stringify(b.header));
  check('I2. the cost total is the sum of every line shown: explorer (usd) + planner + critic + stabilizer', Math.abs(b.header.cost.total - (report.cost.usd + report.cost.plannerUsd + report.cost.criticUsd + report.stability.stabilizerCostUsd)) < 1e-9 && Math.abs(b.header.cost.total - (b.header.cost.explorer + b.header.cost.repair + b.header.cost.planner + b.header.cost.critic + (b.header.cost.stabilizer ?? 0))) < 1e-9, JSON.stringify(b.header.cost));
  const kinds = b.artifacts.map((a) => `${a.kind}:${a.name}`).sort();
  check('J. artifacts list exactly the files on disk, with kinds and API hrefs', JSON.stringify(kinds) === JSON.stringify(['events:events.jsonl', 'meta:run-meta.json', 'report:run-report.json', 'rule-coverage:rule-coverage.json', 'screenshot:landing.png', 'zip:saucedemo-automation-framework.zip'].sort()) && b.artifacts.every((a) => a.href === `/api/runs/${runId}/artifacts/${encodeURIComponent(a.name)}` && a.size > 0), JSON.stringify(kinds));
  check('K. events come from events.jsonl (status present), oldest first, thinking_started not stored', b.events_status === 'present' && b.events?.length === 5 && b.events[0]?.type === 'plan_started' && b.events[4]?.type === 'done' && !b.events.some((e) => e.type === 'thinking_started') && b.events[0]?.t === '2026-09-14T10:00:05.000Z');
  check('L. the stored counts are copied from the index row, not recomputed', b.counts.planned === 5 && b.counts.generated === 2 && b.counts.dropped === 1 && b.counts.skipped === 1 && b.counts.stable === 1);

  /* ─── the six-stage view: every value a report field ─── */
  const st = b.stages;
  const vc = { pass: report.review.verdicts.filter((v) => v.verdict === 'pass').length, rework: report.review.verdicts.filter((v) => v.verdict === 'rework').length, reject: report.review.verdicts.filter((v) => v.verdict === 'reject').length };
  check('SA. every rail stat equals the report field it reads',
    st.discovery.stat === `${report.discovery.pages.length} pages found`
    && st.plan.stat === `${report.plan.length} planned`
    && st.explore.stat === `${report.scenarios.length} recorded · ${report.steps} steps · $${report.cost.usd.toFixed(4)}`
    && st.review.stat === `${vc.pass} pass / ${vc.rework} rework / ${vc.reject} reject`
    && st.verify.stat === `${report.stability.passed} stable / ${report.stability.flaked} flaky`
    && st.summary.stat === `${report.scenarios.length} shipped`,
    JSON.stringify(Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v.stat]))));
  check('SA2. the rail Explore stat carries the 4-decimal explorer cost and no 2-decimal truncation of it', /\$\d+\.\d{4}(?!\d)/.test(st.explore.stat) && !/\$\d+\.\d{2}(?!\d)/.test(st.explore.stat), st.explore.stat);
  check('SB. rail statuses follow the report: discovery warning (robots warning), plan done, explore done, review warning (a reject), verify done, summary warning (an unmatched verdict is a run problem)',
    st.discovery.status === 'warning' && st.plan.status === 'done' && st.explore.status === 'done' && st.review.status === 'warning' && st.verify.status === 'done' && st.summary.status === 'warning',
    JSON.stringify(Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v.status]))));
  const f = st.summary.funnel!;
  check('SC. funnel row counts equal the reconciliation array lengths', f.planned === report.reconciliation.planned && f.generated === report.reconciliation.generated && f.dropped === report.reconciliation.dropped.length && f.incomplete === report.reconciliation.incomplete.length && f.findings === report.reconciliation.findings.length && f.skipped === report.reconciliation.skipped.length && f.balanced === true && f.dropped_by_stage.critic === 1, JSON.stringify(f));
  const cs = st.summary.cost_split;
  check('SD. the cost split sums to the four-term total; explorer is usd minus repair (the one allowed subtraction)', Math.abs(cs.planner + cs.explorer + cs.critic + cs.repair + cs.stabilizer - cs.total) < 1e-9 && Math.abs(cs.total - b.header.cost.total) < 1e-9 && Math.abs(cs.explorer - (report.cost.usd - report.cost.repairUsd)) < 1e-9 && cs.stabilizer === report.stability.stabilizerCostUsd && cs.planner === report.cost.plannerUsd && cs.critic === report.cost.criticUsd && cs.repair === report.cost.repairUsd, JSON.stringify(cs));
  check('SE. discovery panel: rung, pages (source, feature), warnings are the report block verbatim', st.discovery.method === 'sitemap' && st.discovery.pages.length === 2 && st.discovery.pages[1]?.feature === 'cart' && st.discovery.pages[1]?.source === 'sitemap' && st.discovery.warnings[0] === report.discovery.warnings[0], JSON.stringify(st.discovery));
  check('SF. plan panel: every scenario with feature, category, rule ids and page; planner cost is cost.plannerUsd', st.plan.scenarios.length === 5 && st.plan.scenarios[0]?.rule_ids[0] === 'R1' && st.plan.scenarios[0]?.feature === 'login' && st.plan.scenarios[4]?.category === 'edge' && st.plan.planner_usd === report.cost.plannerUsd && st.plan.pages.find((p) => p.url === 'https://www.saucedemo.com/inventory.html')?.count === 4, JSON.stringify(st.plan));
  check('SG. explore panel: steps, recorded, explorer cost, gate injection, skip with reason, heal from report.heals', st.explore.steps === report.steps && st.explore.scenarios_recorded === 2 && st.explore.explorer_usd === report.cost.usd && st.explore.gate_injections.length === 1 && st.explore.gate_injections[0]?.assertion_type === 'toBeVisible' && st.explore.skipped[0]?.reason === 'opens an external site, out of scope' && st.explore.heals[0]?.to === report.heals[0]?.to && st.explore.incomplete.length === 0, JSON.stringify(st.explore));
  check('SH. review panel: verdicts with reasons, journeys from review.repair (kept and dropped), repair count and spend', st.review.verdicts.length === report.review.verdicts.length && st.review.verdicts[0]?.reasons[0] === 'asserts the inventory page' && st.review.journeys.length === 2 && st.review.journeys.find((j) => j.outcome === 'kept')?.second === 'pass' && st.review.journeys.find((j) => j.outcome === 'dropped')?.second === 'reject' && st.review.repair?.count === 2 && st.review.repair?.spent_usd === report.cost.repairUsd && st.review.critic_usd === report.cost.criticUsd, JSON.stringify(st.review));
  check('SI. verify panel: replay pass/fail and stability pattern per scenario as stored, recovered count, stabilizer cost', st.verify.replay?.verdicts.every((v) => v.passed) === true && st.verify.stability?.verdicts.find((v) => v.name === 'add to cart updates the badge')?.pattern === 'PFP' && st.verify.stability?.verdicts.find((v) => v.name === 'add to cart updates the badge')?.recovered === true && st.verify.stability?.recovered === 1 && st.verify.stability?.stabilizer_cost_usd === 0.004 && st.verify.stability?.iterations === 3, JSON.stringify(st.verify));
  check('SJ. summary panel: three numbers (shipped, total, findings plus uncovered), rule coverage with the not-automated list, the zip', st.summary.shipped === 2 && Math.abs(st.summary.total_usd - 1.4154) < 1e-9 && st.summary.findings_count === 1 && st.summary.uncovered_count === 1 && st.summary.attention === 2 && st.summary.rule_coverage?.uncovered[0]?.rule_id === 'R2' && st.summary.rule_coverage?.uncovered[0]?.reason === 'not-planned' && st.summary.zip?.name === 'saucedemo-automation-framework.zip', JSON.stringify(st.summary));
}
const quiet = buildRunDetail(db, root, quietId);
check('M. a run without findings returns an empty findings array (the page still renders the section)', quiet.status === 200 && quiet.body.legacy === false && quiet.body.findings.length === 0);
check('M2. no events.jsonl: events null, events_status absent', quiet.status === 200 && quiet.body.events === null && quiet.body.events_status === 'absent');
check('SK. a report without a discovery block: discovery stage not-applicable, stat "single page"; its one uncovered rule alone makes Summary attention', quiet.status === 200 && quiet.body.legacy === false && quiet.body.stages.discovery.status === 'not-applicable' && quiet.body.stages.discovery.stat === 'single page' && quiet.body.stages.discovery.pages.length === 0 && quiet.body.stages.summary.status === 'attention' && quiet.body.stages.summary.findings_count === 0 && quiet.body.stages.summary.uncovered_count === 1, quiet.status === 200 && quiet.body.legacy === false ? JSON.stringify(quiet.body.stages.discovery) : '');
const emptyRun = buildRunDetail(db, root, emptyId);
check('M3. an empty events.jsonl: events [], events_status empty', emptyRun.status === 200 && Array.isArray(emptyRun.body.events) && emptyRun.body.events.length === 0 && emptyRun.body.events_status === 'empty', JSON.stringify(emptyRun.status === 200 ? { e: emptyRun.body.events, s: emptyRun.body.events_status } : emptyRun.body));
check('SB2. a completed run with 1 finding and 1 uncovered rule and no unmatched verdicts: Summary status attention (product behavior to review), not warning', emptyRun.status === 200 && emptyRun.body.legacy === false && emptyRun.body.unmatched_verdicts.length === 0 && emptyRun.body.stages.summary.status === 'attention' && emptyRun.body.stages.summary.attention === 2, emptyRun.status === 200 && emptyRun.body.legacy === false ? emptyRun.body.stages.summary.status : '');
const missing = buildRunDetail(db, root, 'does-not-exist');
check('N. an unknown run id is a 404 whose message names the path looked for', missing.status === 404 && /does-not-exist/.test(missing.body.error) && /output\/\*\/does-not-exist\/run-report\.json/.test(missing.body.error), JSON.stringify(missing.body));
const gone = buildRunDetail(db, root, goneId);
check('O. an indexed run whose run-report vanished is a 404 naming that exact path, never an empty object', gone.status === 404 && gone.body.error.includes(`output/saucedemo-com/${goneId}/run-report.json`), JSON.stringify(gone.body));
const legacyId = (db.prepare("SELECT id FROM runs WHERE status = 'legacy'").get() as { id: string }).id;
const legacy = buildRunDetail(db, root, legacyId);
check('P. a legacy record returns legacy: true, summary fields, and no scenarios key', legacy.status === 200 && legacy.body.legacy === true && !('scenarios' in legacy.body) && legacy.body.summary.explored === 1 && legacy.body.summary.model === 'claude-opus-4-7' && legacy.body.summary.duration_sec === 255 && legacy.body.header.host === 'demoqa.com', JSON.stringify(legacy.body));

/* ─── over http: token, artifacts served only from the run directory ─── */
const TOKEN = 'detail-token';
const api = createApiHandler({ db, root, token: TOKEN });
const server = http.createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404); res.end(); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const get = async (p: string, headers: Record<string, string> = {}) => { const r = await fetch(base + p, { headers }); return { status: r.status, text: await r.text(), type: r.headers.get('content-type') ?? '' }; };
const auth = { Authorization: `Bearer ${TOKEN}` };
check('Q. /api/runs/:id/detail rejects a request without the token', (await get(`/api/runs/${runId}/detail`)).status === 401);
const viaHttp = await get(`/api/runs/${runId}/detail`, auth);
check('R. /api/runs/:id/detail returns the same body over http', viaHttp.status === 200 && JSON.stringify(JSON.parse(viaHttp.text)) === JSON.stringify(d.body));
check('S. /api/runs/:id/detail for an unknown id is a 404 naming the path', (await get('/api/runs/nope/detail', auth)).status === 404 && /looked for output\/\*\/nope\/run-report\.json/.test((await get('/api/runs/nope/detail', auth)).text));
check('T. artifacts are served from the run directory with their type', (await get(`/api/runs/${runId}/artifacts/rule-coverage.json`, auth)).text === JSON.stringify(report.ruleCoverage) && /image\/png/.test((await get(`/api/runs/${runId}/artifacts/landing.png`, auth)).type) && /application\/zip/.test((await get(`/api/runs/${runId}/artifacts/saucedemo-automation-framework.zip`, auth)).type));
check('U. an artifact name cannot reach outside the run directory', (await get(`/api/runs/${runId}/artifacts/..%2F..%2F..%2Fsecret.txt`, auth)).status === 404 && (await get(`/api/runs/${runId}/artifacts/nope.json`, auth)).status === 404 && (await get(`/api/runs/${legacyId}/artifacts/run-report.json`, auth)).status === 404);
server.close();
db.close();

/* ─── the page ─── */
const repo = process.cwd();
const dist = path.join(repo, 'dashboard', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dashboard/dist is missing. Run `npm run dashboard:build` first.'); process.exit(1); }
const PORT = 18799;
const gw = spawn('npx', ['tsx', path.join(repo, 'src', 'server', 'gateway.ts')], {
  cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, QA_CORE_GATEWAY_PORT: String(PORT), QA_CORE_GATEWAY_TOKEN: TOKEN, QA_CORE_DASHBOARD_DIST: dist, QA_CORE_LEGACY_UI: path.join(repo, 'qa-core-ui.html'), QA_CORE_DB_PATH: path.join(root, 'data', 'qa-core-gw.sqlite'), ANTHROPIC_API_KEY: 'unused' },
});
const killGw = (): void => { if (gw.pid) { try { process.kill(-gw.pid, 'SIGKILL'); } catch { /* gone */ } } };
process.on('exit', killGw);
process.on('uncaughtException', (err) => { console.error(err); killGw(); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error(err); killGw(); process.exit(1); });
let gwLog = '';
gw.stdout.on('data', (c) => { gwLog += String(c); });
gw.stderr.on('data', (c) => { gwLog += String(c); });
const deadline = Date.now() + 60_000;
while (!/listening on/.test(gwLog) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
check('V. gateway boots for the page test', /listening on http/.test(gwLog), gwLog.slice(0, 300));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/runs#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="run-row"]');
await page.click(`[data-run-id="${runId}"] a`);
await page.waitForSelector('[data-testid="run-detail"][data-legacy="false"]');
await page.waitForSelector('[data-testid="scenario-row"]');
// Contrast helper injected as plain script (tsx would inject __name into a named inner function).
await page.addScriptTag({ content: `
window.__contrast = function (selectors) {
  function lum(rgb) { var m = (rgb.match(/[\\d.]+/g) || ['0','0','0']).slice(0, 3).map(function (v) { var c = Number(v) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; }
  function parse(c) { var m = (c.match(/[\\d.]+/g) || ['0','0','0','1']).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; }
  function bgOf(el) {
    var layers = [];
    for (var e = el; e; e = e.parentElement) { var p = parse(getComputedStyle(e).backgroundColor); if (p.a > 0) layers.push(p); if (p.a >= 1) break; }
    var r = 0, g = 0, b = 0;
    for (var i = layers.length - 1; i >= 0; i--) { var l = layers[i]; r = l.r * l.a + r * (1 - l.a); g = l.g * l.a + g * (1 - l.a); b = l.b * l.a + b * (1 - l.a); }
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }
  var out = {};
  selectors.forEach(function (s) { var el = document.querySelector(s); if (!el) { out[s] = -1; return; } var a = lum(getComputedStyle(el).color), bb = lum(bgOf(el)); out[s] = Math.round(((Math.max(a, bb) + 0.05) / (Math.min(a, bb) + 0.05)) * 10) / 10; });
  return out;
};` });
const CONTRAST_SELECTORS = ['[data-testid="rail-item"] .font-semibold', '[data-testid="rail-stat"]', '[data-testid="rail-status"]', '[data-testid="panel-status"]', '[data-testid="funnel-eq"]', '[data-testid="funnel-zero"]', '[data-testid="cost-part"]', '[data-testid="cost-total"]', '[data-testid="verdict-card"] li', '[data-testid="journey"] .text-fg', '[data-testid="findings-heading"]', '[data-testid="finding"] .text-fg-2', '[data-testid="hero-attention"]', '[data-testid="hero-cost"]', '[data-testid="hero-shipped"]', '[data-testid="discovery-page"] .mono', '[data-testid="explore-heal"] .line-through', '[data-testid="uncovered-list"] .text-fg-2', '[data-testid="repair-banner"]', '[data-testid="stability-pattern"]'];
const rendered = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-testid="scenario-row"]')).map((r) => ({
    name: (r as HTMLElement).dataset.scenario,
    verdict: r.querySelector('[data-testid="verdict"]')?.getAttribute('data-verdict') ?? null,
    repair: r.querySelector('[data-testid="repair"]')?.getAttribute('data-repair'),
    replay: r.querySelector('[data-testid="replay"]')?.getAttribute('data-replay') ?? null,
    stability: r.querySelector('[data-testid="stability"]')?.textContent ?? null,
    shipped: r.querySelector('[data-testid="shipped"]')?.getAttribute('data-shipped'),
  }));
  const verdictColors = Array.from(document.querySelectorAll('[data-testid="verdict"]')).map((v) => ({ v: v.getAttribute('data-verdict'), color: getComputedStyle(v).color }));
  const findingsSection = document.querySelector('[data-testid="findings-section"]');
  return {
    rows, verdictColors,
    tableText: document.querySelector('[data-testid="scenarios-table"]')?.textContent ?? '',
    heading: document.querySelector('[data-testid="findings-heading"]')?.textContent ?? '',
    findings: Array.from(findingsSection?.querySelectorAll('[data-testid="finding"]') ?? []).map((f) => f.textContent ?? ''),
    findingsColor: findingsSection ? getComputedStyle(findingsSection.querySelector('h3')!).color : '',
    findingVerdict: document.querySelector('[data-testid="finding-verdict"]')?.getAttribute('data-verdict') ?? null,
    railItems: Array.from(document.querySelectorAll('[data-testid="rail-item"]')).map((r) => ({ stage: r.getAttribute('data-stage'), status: r.getAttribute('data-status'), stat: r.querySelector('[data-testid="rail-stat"]')?.textContent ?? '' })),
    panels: Array.from(document.querySelectorAll('[data-testid="stage-panel"]')).map((p) => ({ stage: p.getAttribute('data-stage'), status: p.getAttribute('data-status'), id: p.id })),
    funnelRows: Array.from(document.querySelectorAll('[data-testid="funnel-row"]')).map((r) => ({ key: r.getAttribute('data-key'), n: Number(r.getAttribute('data-n')) })),
    funnelZero: document.querySelector('[data-testid="funnel-zero"]')?.textContent ?? '',
    funnelBalanced: document.querySelector('[data-testid="funnel-balanced"]')?.textContent ?? '',
    costParts: Array.from(document.querySelectorAll('[data-testid="cost-part"]')).map((c) => ({ part: c.getAttribute('data-part'), usd: Number(c.getAttribute('data-usd')) })),
    costTotal: document.querySelector('[data-testid="cost-total"]')?.textContent ?? '',
    hero: { shipped: document.querySelector('[data-testid="hero-shipped"]')?.textContent, cost: document.querySelector('[data-testid="hero-cost"]')?.textContent, attention: document.querySelector('[data-testid="hero-attention"]')?.textContent, sub: document.querySelector('[data-testid="hero-attention-sub"]')?.textContent },
    discovery: { method: document.querySelector('[data-testid="discovery-method"]')?.textContent, pages: document.querySelectorAll('[data-testid="discovery-page"]').length, warnings: document.querySelector('[data-testid="stage-panel"][data-stage="discovery"]')?.textContent?.includes('robots.txt disallows') },
    plan: { count: document.querySelector('[data-testid="plan-count"]')?.textContent, scenarios: document.querySelectorAll('[data-testid="plan-scenario"]').length, ruleTags: Array.from(document.querySelectorAll('[data-testid="rule-tag"]')).map((t) => t.textContent) },
    explore: { steps: document.querySelector('[data-testid="explore-steps"]')?.textContent, heals: document.querySelectorAll('[data-testid="explore-heal"]').length, skipped: document.querySelector('[data-testid="explore-skipped"]')?.textContent ?? '', injections: document.querySelector('[data-testid="explore-gate-injections"]')?.textContent },
    review: { pass: document.querySelector('[data-testid="review-pass"]')?.textContent, reject: document.querySelector('[data-testid="review-reject"]')?.textContent, cards: document.querySelectorAll('[data-testid="verdict-card"]').length, journeys: Array.from(document.querySelectorAll('[data-testid="journey"]')).map((j) => j.getAttribute('data-outcome')), banner: document.querySelector('[data-testid="repair-banner"]')?.textContent ?? '', unmatchedInReview: !!document.querySelector('[data-stage="review"] [data-testid="unmatched-verdicts"]') },
    verify: { replayRows: Array.from(document.querySelectorAll('[data-testid="replay-row"]')).map((r) => r.getAttribute('data-passed')), patterns: Array.from(document.querySelectorAll('[data-testid="stability-pattern"]')).map((p) => p.textContent), recovered: document.querySelector('[data-testid="stability-recovered"]')?.textContent, stabilizerCost: document.querySelector('[data-testid="stabilizer-cost"]')?.textContent },
    coverage: { covered: document.querySelector('[data-testid="coverage-covered"]')?.textContent, uncovered: document.querySelector('[data-testid="coverage-uncovered"]')?.textContent, list: document.querySelector('[data-testid="uncovered-list"]')?.textContent ?? '' },
    downloads: document.querySelectorAll('[data-testid="download-zip"]').length,
    downloadHref: document.querySelector('[data-testid="download-zip"]')?.getAttribute('href') ?? '',
    findingsInSummary: !!document.querySelector('[data-stage="summary"] [data-testid="findings-section"]'),
    header: { host: document.querySelector('[data-testid="detail-host"]')?.textContent, runId: document.querySelector('[data-testid="detail-run-id"]')?.textContent, cost: document.querySelector('[data-testid="detail-cost"]')?.textContent, status: document.querySelector('[data-testid="run-detail"] [data-status]')?.getAttribute('data-status'), envBadge: !!document.querySelector('[data-testid="env-badge"]') },
    artifacts: Array.from(document.querySelectorAll('[data-testid="artifact-link"]')).map((a) => ({ kind: a.getAttribute('data-kind'), href: a.getAttribute('href') })),
    events: document.querySelectorAll('[data-testid="event-row"]').length,
    unmatched: { text: document.querySelector('[data-testid="unmatched-verdicts"] h3')?.textContent ?? '', items: Array.from(document.querySelectorAll('[data-testid="unmatched-verdict"]')).map((li) => li.textContent ?? '') },
    eventsOpen: (document.querySelector('[data-testid="events-section"]') as HTMLDetailsElement | null)?.open ?? null,
    back: document.querySelector('[data-testid="back-link"]')?.getAttribute('href'),
    rootColors: { pass: getComputedStyle(document.documentElement).getPropertyValue('--pass').trim(), rework: getComputedStyle(document.documentElement).getPropertyValue('--rework').trim(), reject: getComputedStyle(document.documentElement).getPropertyValue('--reject').trim() },
  };
});
check('W. page: four scenario rows with the recorded verdict, repair, replay, stability and shipped values (the skipped one has none)', rendered.rows.length === 4 && JSON.stringify(rendered.rows.map((r) => [r.verdict, r.repair, r.replay, r.shipped])) === JSON.stringify([['pass', 'none', 'pass', 'yes'], ['pass', 'repaired', 'pass', 'yes'], ['reject', 'failed', null, 'no'], [null, 'none', null, 'no']]) && /2\/3/.test(rendered.rows[1]?.stability ?? '') && /PFP/.test(rendered.rows[1]?.stability ?? ''), JSON.stringify(rendered.rows));
check('X. page: the finding sits under "Product behavior to review" and is NOT a scenario row', /^Product behavior to review/.test(rendered.heading) && rendered.findings.length === 1 && /footer social links open/.test(rendered.findings[0] ?? '') && !/footer social links open/.test(rendered.tableText), JSON.stringify({ heading: rendered.heading, table: rendered.tableText.slice(0, 200) }));
check('Y. page: the findings heading is the violet finding color, verdict badges are pass green / reject red (distinct)', rendered.findingsColor !== '' && rendered.verdictColors.find((c) => c.v === 'pass')?.color !== rendered.verdictColors.find((c) => c.v === 'reject')?.color && rendered.verdictColors.find((c) => c.v === 'reject')?.color !== rendered.findingsColor, JSON.stringify(rendered.verdictColors));
check('Z. page: header shows host, run id, status, the four-term cost; no environment badge (environment stored NULL)', rendered.header.host === 'saucedemo.com' && rendered.header.runId === runId && rendered.header.status === 'completed' && rendered.header.cost === '$1.4154' && !rendered.header.envBadge, JSON.stringify(rendered.header));
check('Z2. page: the unmatched verdict is shown under "Critic verdicts that matched no scenario", not in the table', /^Critic verdicts that matched no scenario/.test(rendered.unmatched.text) && rendered.unmatched.items.length === 1 && /checkout with an empty cart/.test(rendered.unmatched.items[0] ?? '') && !/checkout with an empty cart/.test(rendered.tableText), JSON.stringify(rendered.unmatched));
check('AA. page: artifact links only for files present, token carried on the href', rendered.artifacts.length === 6 && rendered.artifacts.every((a) => a.href?.includes(`token=${TOKEN}`)) && rendered.artifacts.some((a) => a.kind === 'zip') && rendered.artifacts.some((a) => a.kind === 'screenshot'), JSON.stringify(rendered.artifacts));
check('AB. page: events timeline is collapsible (closed) with the 5 stored events', rendered.eventsOpen === false && rendered.events === 5);
check('AC. page: back link goes to the run\'s project', rendered.back === '/runs?project_id=saucedemo-com', String(rendered.back));

/* ─── the stage view on the page ─── */
if (d.status === 200 && d.body.legacy === false) {
  const st = d.body.stages;
  const order = ['discovery', 'plan', 'explore', 'review', 'verify', 'summary'] as const;
  check('SL. page: six rail items in pipeline order, each with the API status and the API stat verbatim', JSON.stringify(rendered.railItems) === JSON.stringify(order.map((k) => ({ stage: k, status: st[k].status, stat: st[k].stat }))), JSON.stringify(rendered.railItems));
  check('SM. page: six panels in the same order with matching status and anchor ids', JSON.stringify(rendered.panels) === JSON.stringify(order.map((k) => ({ stage: k, status: st[k].status, id: `stage-${k}` }))), JSON.stringify(rendered.panels));
  const f = st.summary.funnel!;
  check('SN. page: funnel rows are the reconciliation counts, zero rows collapse into one line, balanced shown', JSON.stringify(rendered.funnelRows) === JSON.stringify([{ key: 'planned', n: f.planned }, { key: 'generated', n: f.generated }, { key: 'dropped', n: f.dropped }, { key: 'findings', n: f.findings }, { key: 'skipped', n: f.skipped }]) && rendered.funnelZero === 'incomplete 0' && rendered.funnelBalanced === 'balanced', JSON.stringify({ rows: rendered.funnelRows, zero: rendered.funnelZero, bal: rendered.funnelBalanced }));
  const partSum = rendered.costParts.reduce((a, c) => a + c.usd, 0);
  check('SO. page: the cost split shows planner / explorer / critic / repair / stabilizer and they sum to the displayed total', rendered.costParts.map((c) => c.part).join(',') === 'planner,explorer,critic,repair,stabilizer' && Math.abs(partSum - st.summary.cost_split.total) < 1e-9 && rendered.costTotal === `$${st.summary.cost_split.total.toFixed(4)}`, JSON.stringify({ parts: rendered.costParts, total: rendered.costTotal }));
  check('SP. page: the three summary numbers lead (tests shipped, total cost at 4 decimals, findings plus uncovered rules)', rendered.hero.shipped === '2' && rendered.hero.cost === '$1.4154' && rendered.hero.attention === '2' && rendered.hero.sub === '1 finding · 1 uncovered rule', JSON.stringify(rendered.hero));
  check('SQ. page: discovery panel shows the rung, both pages and the robots warning', rendered.discovery.method === 'sitemap' && rendered.discovery.pages === 2 && rendered.discovery.warnings === true, JSON.stringify(rendered.discovery));
  check('SR. page: plan panel lists every scenario with its rule-id tag', rendered.plan.count === '5' && rendered.plan.scenarios === 5 && JSON.stringify(rendered.plan.ruleTags) === JSON.stringify(['R1']), JSON.stringify(rendered.plan));
  check('SS. page: explore panel shows steps, the gate injection, the skip with its reason and the selector recovery', rendered.explore.steps === '31' && rendered.explore.injections === '1' && /opens an external site, out of scope/.test(rendered.explore.skipped) && rendered.explore.heals === 1, JSON.stringify(rendered.explore));
  check('SU. page: review panel shows the verdict counts, a card per verdict, both journeys, the repair banner and the unmatched warning', rendered.review.pass === '2' && rendered.review.reject === '2' && rendered.review.cards === 5 && JSON.stringify(rendered.review.journeys) === JSON.stringify(['kept', 'dropped']) && /repair pass/.test(rendered.review.banner) && /2 scenarios re-explored/.test(rendered.review.banner) && rendered.review.unmatchedInReview, JSON.stringify(rendered.review));
  check('SV. page: verify panel shows replay pass per scenario, the stored stability patterns, recovered count and stabilizer cost', JSON.stringify(rendered.verify.replayRows) === JSON.stringify(['yes', 'yes']) && JSON.stringify(rendered.verify.patterns) === JSON.stringify(['PPP', 'PFP']) && rendered.verify.recovered === '1' && rendered.verify.stabilizerCost === '$0.0040', JSON.stringify(rendered.verify));
  check('SW. page: rule coverage shows covered of total and the considered-not-automated list', rendered.coverage.covered === '1' && rendered.coverage.uncovered === '1' && /R2/.test(rendered.coverage.list) && /Lockout after 5 failed logins/.test(rendered.coverage.list) && /not-planned/.test(rendered.coverage.list), JSON.stringify(rendered.coverage));
  check('SX. page: the finding card carries its Critic verdict, sits inside the Summary panel, and exactly one download button exists', rendered.findingVerdict === 'reject' && rendered.findingsInSummary && rendered.downloads === 1 && rendered.downloadHref.includes('saucedemo-automation-framework.zip') && rendered.downloadHref.includes(`token=${TOKEN}`), JSON.stringify({ v: rendered.findingVerdict, inSummary: rendered.findingsInSummary, downloads: rendered.downloads, href: rendered.downloadHref }));
  const yBefore = await page.evaluate(() => window.scrollY);
  await page.click('[data-testid="rail-item"][data-stage="summary"]');
  await page.waitForTimeout(600);
  const yAfter = await page.evaluate(() => window.scrollY);
  const summaryTop = await page.evaluate(() => document.getElementById('stage-summary')!.getBoundingClientRect().top);
  check('SY. page: clicking a rail item scrolls to its panel', yAfter > yBefore && summaryTop >= 0 && summaryTop < 120, JSON.stringify({ yBefore, yAfter, summaryTop }));
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => { document.documentElement.classList.toggle('light', t === 'light'); localStorage.setItem('qa-core.theme', t); }, theme);
    await page.waitForTimeout(150);
    const contrast = await page.evaluate((sel) => (window as unknown as { __contrast: (s: string[]) => Record<string, number> }).__contrast(sel), CONTRAST_SELECTORS) as Record<string, number>;
    const weakest = Math.min(...Object.values(contrast));
    check(`SZ-${theme}. page: every stage-view text keeps at least 4.5:1 contrast against its background (${theme})`, weakest >= 4.5 && Object.values(contrast).every((v) => v > 0), JSON.stringify(contrast));
  }
  await page.evaluate(() => { document.documentElement.classList.remove('light'); localStorage.setItem('qa-core.theme', 'dark'); });
}
if (process.env.QA_CORE_SMOKE_SHOTS) {
  fs.mkdirSync(process.env.QA_CORE_SMOKE_SHOTS, { recursive: true });
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => { document.documentElement.classList.toggle('light', t === 'light'); localStorage.setItem('qa-core.theme', t); }, theme);
    // A sticky header repeats mid-page in a full-page capture; pin it for the shot only.
    await page.evaluate(() => { document.querySelector('header.sticky')?.classList.replace('sticky', 'static'); window.scrollTo(0, 0); });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(process.env.QA_CORE_SMOKE_SHOTS, `run-detail-${theme}.png`), fullPage: true });
    await page.evaluate(() => { document.querySelector('header.static')?.classList.replace('static', 'sticky'); });
  }
}
// A run with no findings keeps the section with "No findings recorded".
await page.goto(`http://127.0.0.1:${PORT}/runs/${quietId}#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="findings-section"]');
check('AD. page: a run with zero findings still shows the section with "No findings recorded"', /No findings recorded/.test((await page.textContent('[data-testid="findings-section"]')) ?? ''));
check('SK2. page: a single-page run renders "single-page run, no discovery" in the Discovery panel, marked not run', (await page.textContent('[data-testid="discovery-na"]')) === 'single-page run, no discovery' && (await page.getAttribute('[data-testid="rail-item"][data-stage="discovery"]', 'data-status')) === 'not-applicable');
check('AD2. page: a run with no events.jsonl says so ("No events log; this run predates event capture"), no empty timeline', /No events log; this run predates event capture/.test((await page.textContent('[data-testid="events-section"]')) ?? '') && (await page.$$('[data-testid="event-row"]')).length === 0, (await page.textContent('[data-testid="events-section"]')) ?? '');
await page.goto(`http://127.0.0.1:${PORT}/runs/${emptyId}#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="events-section"]');
check('AD3. page: an empty events.jsonl says "No events recorded"', /No events recorded/.test((await page.textContent('[data-testid="events-section"]')) ?? '') && (await page.$$('[data-testid="event-row"]')).length === 0, (await page.textContent('[data-testid="events-section"]')) ?? '');
const attentionRail = await page.evaluate(() => { const item = document.querySelector('[data-testid="rail-item"][data-stage="summary"]'); const status = item?.querySelector('[data-testid="rail-status"]'); return { status: item?.getAttribute('data-status'), cls: status?.className ?? '', text: status?.textContent, color: status ? getComputedStyle(status).color : '', findingColor: getComputedStyle(document.documentElement).getPropertyValue('--finding').trim(), reworkColor: getComputedStyle(document.documentElement).getPropertyValue('--rework').trim() }; });
check('SB3. page: the attention rail item carries the finding colour class, not the warning class', attentionRail.status === 'attention' && /text-finding/.test(attentionRail.cls) && !/text-rework/.test(attentionRail.cls) && attentionRail.text === 'to review', JSON.stringify(attentionRail));
// Legacy notice.
await page.goto(`http://127.0.0.1:${PORT}/runs/${legacyId}#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="run-detail"][data-legacy="true"]');
const legacyText = (await page.textContent('main')) ?? '';
check('AE. page: a legacy run shows the plain notice and no scenarios table', /pre-v2 record, per-scenario detail not captured/.test(legacyText) && !(await page.$('[data-testid="scenarios-table"]')) && !(await page.$('[data-testid="findings-section"]')));
// Missing run: loud 404 on the page.
await page.goto(`http://127.0.0.1:${PORT}/runs/does-not-exist#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="detail-error"]');
check('AF. page: an unknown run shows the 404 message with the path looked for', /looked for output\/\*\/does-not-exist\/run-report\.json/.test((await page.textContent('[data-testid="detail-error"]')) ?? ''));
check('AG. page: zero console errors', errors.filter((e) => !/404/.test(e)).length === 0, errors.join(' | '));
await browser.close();
killGw();
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: Run Detail renders only stored values from the run folder; a missing run-report is a loud 404; findings are never scenario rows.');
