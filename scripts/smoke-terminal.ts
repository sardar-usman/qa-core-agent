/**
 * Locks the Terminal page and the live run view (dashboard v2 plan, PR C,
 * single-terminal scope):
 *   - the composer form serializes to a command that parseExploreTokens (the
 *     ONE parser) turns back into the field's value, for every EXPLORE_FLAGS
 *     row the form exposes; a full form round-trips through formFromRequest
 *   - the page shows the exact command it sends and the request the gateway
 *     parsed from it; a typed command fills the form
 *   - SRS upload: each allowed extension lands in the run folder under its
 *     name and Run Detail lists it as kind "srs"; a .exe and a 3 MB file are
 *     rejected with the stated messages, client-side and server-side alike
 *   - Start is disabled with the reason while a run is live, when the URL is
 *     empty, or when the socket is not connected
 *   - the live stage view fed a fixture event stream (through a fake gateway
 *     speaking the real message shapes) ending in run_report renders the same
 *     panels, byte for byte, as the history view of the same report; a socket
 *     drop mid-run shows the reconnect offer and the page catches up from the
 *     run folder's events.jsonl
 * No model, no real run. The fake gateway reuses the real API handler and
 * static handler over a fixture output tree; only the run itself is faked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { chromium } from 'playwright';
import { openDatabase } from '../src/server/db/migrate.js';
import { indexOutput } from '../src/server/db/indexer.js';
import { createApiHandler, parseCommandForUi } from '../src/server/api.js';
import { createStaticHandler } from '../src/server/static.js';
import { listArtifacts } from '../src/server/run-detail.js';
import { appendRunEvent, readRunEvents } from '../src/server/events.js';
import { loadReportForUi } from '../src/server/runs.js';
import { prepareExploreRun, saveSrsUpload, validateSrsUpload, SRS_MAX_BYTES } from '../src/server/run-explore.js';
import { EXPLORE_FLAGS, parseExploreTokens, tokenizeCommand, defaultExploreRequest } from '../src/agent/explore-request.js';
import { newRunId } from '../src/agent/output-layout.js';
import type { AgentEvent } from '../src/agent/runtime.js';
import { buildCommand, defaultForm, formFromRequest, startBlocker, validateSrsFile, FORM_FIELDS, type TerminalForm } from '../dashboard/src/lib/command.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};
const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const parseCmd = (cmd: string) => parseExploreTokens(tokenizeCommand(cmd.replace(/^\/explore\s*/, '')));

/* ─── A. the form and the one parser ─── */

const formRows = EXPLORE_FLAGS.filter((f) => f.form);
check('A1. every form field (except the positional URL) names an EXPLORE_FLAGS row whose form column is that field', FORM_FIELDS.filter((f) => f.field !== 'url').every((f) => formRows.some((r) => r.form === f.field && (r.flag === f.flag || ['--pom', '--inline', '--stabilize'].includes(r.flag)))), JSON.stringify(FORM_FIELDS));
check('A2. every EXPLORE_FLAGS row with a form column is gateway-reachable and its field exists on the form', formRows.every((r) => r.gateway && FORM_FIELDS.some((f) => f.field === r.form)), JSON.stringify(formRows.map((r) => [r.flag, r.form])));
check('A3. the default form serializes to a bare /explore and its blocker is the URL', buildCommand(defaultForm()) === '/explore' && startBlocker({ socket: 'connected', activeRunId: null, command: '/explore' }) === 'enter a URL');

const samples: Array<{ field: keyof TerminalForm; value: TerminalForm[keyof TerminalForm]; expect: (r: ReturnType<typeof defaultExploreRequest>, positional: string[]) => boolean }> = [
  { field: 'url', value: 'https://shop.example/', expect: (_r, p) => p[0] === 'https://shop.example/' },
  { field: 'features', value: 'login, cart', expect: (r) => JSON.stringify(r.features) === '["login","cart"]' },
  { field: 'urls', value: '/login,/cart', expect: (r) => JSON.stringify(r.urls) === '["/login","/cart"]' },
  { field: 'discover', value: true, expect: (r) => r.discover === true },
  { field: 'pom', value: false, expect: (r) => r.pom === false && r.pomProvided },
  { field: 'lang', value: 'js', expect: (r) => r.lang === 'js' && r.langProvided },
  { field: 'stabilize', value: false, expect: (r) => r.stabilize === false },
  { field: 'stabilizeAttempts', value: '2', expect: (r) => r.stabilizeAttempts === 2 },
  { field: 'ceiling', value: '3', expect: (r) => r.env.QA_CORE_COST_CEILING === '3' },
  { field: 'repairReserve', value: '0.2', expect: (r) => r.env.QA_CORE_REPAIR_RESERVE === '0.2' },
  { field: 'maxSteps', value: '60', expect: (r) => r.env.QA_CORE_MAX_STEPS === '60' },
  { field: 'plannerModel', value: 'claude-haiku-4-5', expect: (r) => r.env.QA_CORE_PLANNER_MODEL === 'claude-haiku-4-5' },
  { field: 'explorerModel', value: 'claude-opus-4-7', expect: (r) => r.env.QA_CORE_EXPLORER_MODEL === 'claude-opus-4-7' },
  { field: 'criticModel', value: 'claude-sonnet-4-6', expect: (r) => r.env.QA_CORE_CRITIC_MODEL === 'claude-sonnet-4-6' },
];
for (const s of samples) {
  const form = { ...defaultForm(), [s.field]: s.value } as TerminalForm;
  const cmd = buildCommand(form);
  const parsed = parseCmd(cmd);
  check(`A4. field ${s.field}: the built command parses (through parseExploreTokens) to the field's value`, parsed.ok && s.expect(parsed.request, parsed.positional), `${cmd} -> ${parsed.ok ? JSON.stringify(parsed.request) : parsed.error}`);
}
const fullForm: TerminalForm = { url: 'https://shop.example/', features: 'login,cart', urls: '/login,/cart', discover: true, pom: false, lang: 'js', stabilize: false, stabilizeAttempts: '2', ceiling: '3', repairReserve: '0.2', maxSteps: '60', plannerModel: 'claude-haiku-4-5', explorerModel: 'claude-opus-4-7', criticModel: 'claude-sonnet-4-6' };
const fullParsed = parseCmd(buildCommand(fullForm));
check('A5. a full form round-trips: command -> parseExploreTokens -> formFromRequest equals the form', fullParsed.ok && same(formFromRequest({ ...fullParsed.request, url: fullParsed.positional[0] }), fullForm), fullParsed.ok ? JSON.stringify(formFromRequest({ ...fullParsed.request, url: fullParsed.positional[0] })) : fullParsed.error);
check('A6. the server parse endpoint and parseExploreTokens agree on the full command', (() => { const p = parseCommandForUi(buildCommand(fullForm), 'ts'); return p.ok && p.kind === 'explore' && fullParsed.ok && same(p.request, { ...fullParsed.request, url: fullParsed.positional[0] }); })());
check('A7. Start blockers: socket, live run, URL, in that order', startBlocker({ socket: 'offline', activeRunId: 'r1', command: '/explore https://x/' }) === 'the gateway socket is not connected' && startBlocker({ socket: 'connected', activeRunId: 'r1', command: '/explore https://x/' }) === 'a run is already in progress: r1' && startBlocker({ socket: 'connected', activeRunId: null, command: '/explore --discover' }) === 'enter a URL' && startBlocker({ socket: 'connected', activeRunId: null, command: '/resume output/x/checkpoint.json' }) === null && startBlocker({ socket: 'connected', activeRunId: null, command: '/explore https://x/' }) === null);

/* ─── B. SRS upload rules, client and server ─── */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-terminal-'));
const big = 3 * 1024 * 1024;
check('B1. every allowed extension passes validation', ['a.md', 'b.txt', 'c.pdf', 'd.docx', 'E.MD'].every((n) => validateSrsUpload(n, 100) === null));
const exeMsg = validateSrsUpload('setup.exe', 100);
check('B2. a .exe is rejected with a message naming the four allowed types', !!exeMsg && /Allowed: \.md, \.txt, \.pdf, \.docx\./.test(exeMsg), exeMsg ?? '');
const bigMsg = validateSrsUpload('big.md', big);
check('B3. a 3 MB file is rejected with a message stating the 2 MB cap', !!bigMsg && /3\.0 MB; the cap is 2 MB\./.test(bigMsg) && SRS_MAX_BYTES === 2 * 1024 * 1024, bigMsg ?? '');
check('B4. the client-side rule gives the identical messages', validateSrsFile('setup.exe', 100) === exeMsg && validateSrsFile('big.md', big) === bigMsg && validateSrsFile('ok.docx', 10) === null);
const srsRun = path.join(root, 'output', 'shop-example', newRunId(new Date('2026-09-15T10:00:00Z'), 'srs'));
for (const name of ['requirements.md', 'notes.txt', 'spec.pdf', 'brief.docx']) saveSrsUpload(srsRun, { name, base64: Buffer.from(`# ${name}`).toString('base64') });
const srsArtifacts = listArtifacts(srsRun, 'x').filter((a) => a.kind === 'srs').map((a) => a.name).sort();
check('B5. each upload lands in the run folder under its original name and Run Detail lists it as kind srs', JSON.stringify(srsArtifacts) === JSON.stringify(['brief.docx', 'notes.txt', 'requirements.md', 'spec.pdf']) && fs.readFileSync(path.join(srsRun, 'requirements.md'), 'utf8') === '# requirements.md', JSON.stringify(srsArtifacts));
check('B6. saveSrsUpload refuses a .exe and an oversized file server-side', (() => { try { saveSrsUpload(srsRun, { name: 'x.exe', base64: 'aGk=' }); return false; } catch (e) { return /Allowed:/.test((e as Error).message); } })() && (() => { try { saveSrsUpload(srsRun, { name: 'huge.txt', base64: Buffer.alloc(big).toString('base64') }); return false; } catch (e) { return /cap is 2 MB/.test((e as Error).message); } })());
const prepBad = await prepareExploreRun({ request: { ...defaultExploreRequest(), url: 'https://shop.example/' }, projectRoot: root, srsUpload: { name: 'x.exe', base64: 'aGk=' } }).then(() => null, (e: Error) => e.message);
check('B7. prepareExploreRun rejects a bad upload before anything is billed, with the same message', !!prepBad && /Allowed: \.md, \.txt, \.pdf, \.docx\./.test(prepBad), prepBad ?? 'no error');

/* ─── C. fixture run, fake gateway, real API and static handlers ─── */

const runId = newRunId(new Date('2026-09-15T12:00:00Z'), 'live');
const runDir = path.join(root, 'output', 'saucedemo-com', runId);
fs.mkdirSync(runDir, { recursive: true });
const step = (url: string) => ({ kind: 'navigate', url });
const report = {
  url: 'https://www.saucedemo.com/', language: 'ts', startedAt: '2026-09-15T12:00:00.000Z', finishedAt: '2026-09-15T12:03:00.000Z', steps: 14,
  scenarios: [
    { name: 'login succeeds with valid credentials', feature: 'login', category: 'happy', steps: [step('https://www.saucedemo.com/')] },
    { name: 'add to cart updates the badge', feature: 'cart', category: 'happy', steps: [step('https://www.saucedemo.com/')] },
  ],
  cascadeStats: {}, cost: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0.9, plannerUsd: 0.0021, criticUsd: 0.0093, repairUsd: 0.2 },
  plan: [
    { name: 'login succeeds with valid credentials', category: 'happy', rationale: 'r', feature: 'login' },
    { name: 'add to cart updates the badge', category: 'happy', rationale: 'r', feature: 'cart' },
    { name: 'footer social links open', category: 'happy', rationale: 'r', feature: 'footer' },
  ],
  review: {
    verdicts: [
      { scenario: '1. [happy] login succeeds with valid credentials', verdict: 'pass', reasons: ['asserts the inventory page'], required_fixes: [] },
      { scenario: '2. [happy] add to cart updates the badge', verdict: 'pass', reasons: ['captures the badge count before and after'], required_fixes: [] },
      { scenario: '3. [happy] footer social links open', verdict: 'reject', reasons: ['asserts a redirect the page never produced'], required_fixes: [] },
    ],
    summary: 'Two scenarios ship; one was repaired.',
    repair: [{ scenario: 'add to cart updates the badge', first: 'rework', second: 'pass', outcome: 'kept' }],
  },
  replay: { passed: 2, failed: 0, durationMs: 5000, verdicts: [{ name: 'login succeeds with valid credentials', passed: true, durationMs: 2000 }, { name: 'add to cart updates the badge', passed: true, durationMs: 2500 }] },
  stability: { iterations: 3, passed: 2, flaked: 0, flakeRate: 0, durationMs: 9000, recovered: 1, stabilizerCostUsd: 0.004, verdicts: [
    { name: 'login succeeds with valid credentials', iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'P-P-P', durationMs: 4000 },
    { name: 'add to cart updates the badge', iterations: 3, passes: 2, stable: true, classification: 'stable', pattern: 'P-F-P', relaxed: true, durationMs: 5000 },
  ] },
  findings: [{ scenario: 'footer social links open', category: 'happy', expected: 'a new tab with twitter.com', url: 'https://www.saucedemo.com/inventory.html', messages: [] }],
  reconciliation: { planned: 3, generated: 2, dropped: [], incomplete: [], findings: [{ name: 'footer social links open', expected: 'a new tab with twitter.com', url: 'https://www.saucedemo.com/inventory.html', messages: [] }], skipped: [], accountedFor: 3, added: 0, balanced: true, stable: 1, recovered: 1, flaky: 0, broken: 0 },
};
fs.writeFileSync(path.join(runDir, 'run-report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(runDir, 'saucedemo-automation-framework.zip'), 'PKzip');
fs.writeFileSync(path.join(runDir, 'requirements.md'), '# SRS');
fs.writeFileSync(path.join(runDir, 'run-meta.json'), JSON.stringify({ source: 'dashboard', flags: {}, writtenAt: 'x' }));
fs.writeFileSync(path.join(runDir, 'events.jsonl'), '');

// The stream the fake gateway plays: the real AgentEvent shapes, appended to events.jsonl as they go out.
const liveEvents: AgentEvent[] = [
  { type: 'plan_started' },
  { type: 'plan_done', scenarios: report.plan as never, usd: 0.0021 },
  { type: 'tool_call', name: 'begin_scenario', input: { name: 'login succeeds with valid credentials' } },
  { type: 'tool_result', name: 'begin_scenario', ok: true },
  { type: 'usage', usd: 0.3, tokens: 1000 },
  { type: 'tool_call', name: 'end_scenario', input: {} },
  { type: 'tool_result', name: 'end_scenario', ok: true },
  { type: 'tool_call', name: 'begin_scenario', input: { name: 'add to cart updates the badge' } },
  { type: 'tool_result', name: 'begin_scenario', ok: true },
  { type: 'heal', from: 'button#add', to: 'getByRole("button")', intent: 'add to cart button', scenario: 'add to cart updates the badge' },
  { type: 'usage', usd: 0.6, tokens: 2000 },
  { type: 'tool_call', name: 'end_scenario', input: {} },
  { type: 'tool_result', name: 'end_scenario', ok: true },
  { type: 'critic_started' },
  { type: 'critic_done', verdicts: report.review.verdicts, usd: 0.0093 },
  { type: 'replay_started', total: 2 },
  { type: 'replay_scenario_passed', name: 'login succeeds with valid credentials', durationMs: 2000 },
  { type: 'replay_scenario_passed', name: 'add to cart updates the badge', durationMs: 2500 },
  { type: 'replay_done', passed: 2, failed: 0, durationMs: 5000 },
  { type: 'stability_started', total: 2, iterations: 3 },
  { type: 'stability_iteration_passed', name: 'login succeeds with valid credentials', iteration: 1, durationMs: 1 },
  { type: 'stability_iteration_failed', name: 'add to cart updates the badge', iteration: 1, failedStep: 3, stepKind: 'assert', error: 'badge read 0' },
  { type: 'stability_done', stable: 2, flaked: 0, recovered: 1, iterations: 3, flakeRate: 0, durationMs: 9000, stabilizerCostUsd: 0.004 },
  { type: 'done', scenarios: 2 },
];
const DROP_AT = 9;

const db = openDatabase(path.join(root, 'data', 'qa-core.sqlite'));
indexOutput(db, root);
const TOKEN = 'terminal-token';
const repo = process.cwd();
const dist = path.join(repo, 'dashboard', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dashboard/dist is missing. Run `npm run dashboard:build` first.'); process.exit(1); }
const apiHandler = createApiHandler({ db, root, token: TOKEN });
const statik = createStaticHandler({ distDir: dist, legacyFile: path.join(repo, 'qa-core-ui.html') });
const server = http.createServer(async (req, res) => { if (await apiHandler(req, res)) return; if (statik(req, res)) return; res.writeHead(404); res.end(); });
const wss = new WebSocketServer({ server });
const send = (ws: WebSocket, p: object) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(p)); };
// Fake gateway state: the real message shapes, a scripted run.
let active: { run_id: string; run_dir: string; url: string; started_at: string } | null = null;
let busyOverride: { run_id: string; run_dir: string; url: string; started_at: string } | null = null;
const received: Array<Record<string, unknown>> = [];
let streamIndex = 0;
let dropped = false;
let finished = false;
const watchers = new Set<WebSocket>();
let requester: WebSocket | null = null;
const broadcastActive = () => { for (const c of wss.clients) send(c, { type: 'active_run', run: busyOverride ?? active }); };
const toRun = (p: object) => { const body = { run_id: runId, ...p }; if (requester) send(requester, body); for (const w of watchers) if (w !== requester) send(w, body); };
const streamFrom = (i: number): void => {
  streamIndex = i;
  const tick = (): void => {
    if (streamIndex >= liveEvents.length) {
      finished = true;
      toRun({ type: 'run_report', report: { ...report, scenarios: report.scenarios.map(({ steps, ...r }) => ({ ...r, stepCount: steps.length })) }, outcome: loadReportForUi(root, path.relative(root, path.join(runDir, 'run-report.json'))).outcome });
      active = null; broadcastActive();
      return;
    }
    if (streamIndex === DROP_AT && !dropped) {
      dropped = true;
      for (const c of wss.clients) c.terminate();
      return; // resumes when a reconnected socket catches up
    }
    const e = liveEvents[streamIndex++]!;
    appendRunEvent(runDir, e, new Date(Date.UTC(2026, 8, 15, 12, 0, streamIndex)));
    toRun({ type: 'event', event: e });
    if (e.type === 'plan_done') toRun({ text: `  ${e.scenarios.length} scenarios planned` });
    setTimeout(tick, 15);
  };
  setTimeout(tick, 15);
};
wss.on('connection', (ws) => {
  send(ws, { text: 'Connected to fake gateway.' });
  send(ws, { type: 'settings', settings: [{ name: 'QA_CORE_COST_CEILING', label: 'Cost ceiling (USD)', value: '2.00', fromEnv: false }, { name: 'QA_CORE_PLANNER_MODEL', label: 'Planner model', value: 'claude-haiku-4-5', fromEnv: false }] });
  send(ws, { type: 'active_run', run: busyOverride ?? active });
  ws.on('close', () => watchers.delete(ws));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (msg.type === 'active_run') { send(ws, { type: 'active_run', run: busyOverride ?? active }); return; }
    if ((msg.type === 'watch' || msg.type === 'catch_up') && msg.run_id === runId) {
      watchers.add(ws);
      if (msg.type === 'catch_up') {
        const loaded = finished ? loadReportForUi(root, path.relative(root, path.join(runDir, 'run-report.json'))) : null;
        send(ws, { type: 'catch_up', run_id: runId, found: true, active: !!active, run_dir: path.relative(root, runDir), events: readRunEvents(runDir), report: loaded?.report ?? null, outcome: loaded?.outcome ?? null });
        if (dropped && !finished && streamIndex === DROP_AT) { requester = ws; setTimeout(() => streamFrom(DROP_AT), 200); }
      }
      return;
    }
    if (msg.type === 'message') {
      received.push(msg);
      if (busyOverride || active) { send(ws, { text: `⏳ Another explore run is active on this gateway (a run is already in progress: ${(busyOverride ?? active)!.run_id}).` }); send(ws, { type: 'run_failed', error: `a run is already in progress: ${(busyOverride ?? active)!.run_id}` }); return; }
      requester = ws; watchers.add(ws);
      active = { run_id: runId, run_dir: path.relative(root, runDir), url: report.url, started_at: new Date().toISOString() };
      broadcastActive();
      toRun({ type: 'run_started', run_dir: path.relative(root, runDir), command: 'explore', request: { url: report.url, lang: 'ts', pom: true, features: ['login', 'cart'], srs: (msg.srs as { name?: string } | undefined)?.name ?? null, discover: false, urls: [], resume: null, stabilize: true, stabilizeAttempts: 3, env: {} }, settings: [] });
      toRun({ text: '▸ Exploring https://www.saucedemo.com/' });
      streamFrom(0);
    }
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const PORT = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}/terminal#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="composer"]');
await page.waitForFunction(() => document.querySelector('[data-testid="gateway-status"]')?.textContent?.includes('connected'));
check('C1. with an empty URL, Start is disabled and says why', (await page.isDisabled('[data-testid="start"]')) && (await page.textContent('[data-testid="start-blocker"]')) === 'enter a URL');

// Fill every form field and compare the displayed command's parse with the page's parsed request.
await page.fill('[data-testid="f-url"]', fullForm.url);
await page.fill('[data-testid="f-features"]', fullForm.features);
await page.fill('[data-testid="f-urls"]', fullForm.urls);
await page.click('[data-testid="f-discover"]');
await page.click('[data-testid="f-pom"]');
await page.selectOption('[data-testid="f-lang"]', 'js');
await page.click('[data-testid="f-stabilize"]');
// attempts is disabled while the stabilizer is off; set it with the stabilizer on, then turn it off again
await page.click('[data-testid="f-stabilize"]');
await page.fill('[data-testid="f-stabilizeAttempts"]', fullForm.stabilizeAttempts);
await page.click('[data-testid="f-stabilize"]');
for (const f of ['ceiling', 'repairReserve', 'maxSteps', 'plannerModel', 'explorerModel', 'criticModel'] as const) await page.fill(`[data-testid="f-${f}"]`, fullForm[f]);
const shownCommand = await page.inputValue('[data-testid="command"]');
check('C2. the page shows exactly the command buildCommand produces for the form', shownCommand === buildCommand(fullForm), shownCommand);
await page.waitForSelector('[data-testid="parsed-request"]', { state: 'attached' });
await page.waitForFunction((cmd) => { const pre = document.querySelector('[data-testid="parsed-request"]'); return !!pre && (pre.textContent ?? '').includes('shop.example') && document.querySelector<HTMLTextAreaElement>('[data-testid="command"]')?.value === cmd; }, shownCommand);
const pageParsed = JSON.parse((await page.textContent('[data-testid="parsed-request"]')) ?? '{}') as Record<string, unknown>;
const localParsed = parseCmd(shownCommand);
check('C3. the request the page shows (parsed by the gateway) equals parseExploreTokens on the displayed command', localParsed.ok && same(pageParsed, { ...localParsed.request, url: localParsed.positional[0] }), JSON.stringify({ pageParsed, local: localParsed.ok && localParsed.request }));
check('C4. with a URL and a connected socket, Start is enabled', !(await page.isDisabled('[data-testid="start"]')));

// A typed command fills the form.
await page.fill('[data-testid="command"]', '/explore https://other.example/ --no-pom --lang js --ceiling 5 --features a,b --no-stabilize');
await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[data-testid="f-url"]')?.value === 'https://other.example/');
const formAfter = await page.evaluate(() => ({
  url: (document.querySelector('[data-testid="f-url"]') as HTMLInputElement).value,
  features: (document.querySelector('[data-testid="f-features"]') as HTMLInputElement).value,
  pom: document.querySelector('[data-testid="f-pom"]')?.getAttribute('data-checked'),
  lang: (document.querySelector('[data-testid="f-lang"]') as HTMLSelectElement).value,
  ceiling: (document.querySelector('[data-testid="f-ceiling"]') as HTMLInputElement).value,
  stabilize: document.querySelector('[data-testid="f-stabilize"]')?.getAttribute('data-checked'),
  discover: document.querySelector('[data-testid="f-discover"]')?.getAttribute('data-checked'),
}));
check('C5. a typed command fills the form from the gateway-parsed request', formAfter.url === 'https://other.example/' && formAfter.features === 'a,b' && formAfter.pom === 'false' && formAfter.lang === 'js' && formAfter.ceiling === '5' && formAfter.stabilize === 'false' && formAfter.discover === 'false', JSON.stringify(formAfter));
const badRaw = '/explore https://other.example/ --disocver';
await page.fill('[data-testid="command"]', badRaw);
await page.waitForSelector('[data-testid="parse-error"]');
check('C6. a bad flag in the raw box shows the parser\'s own error and disables Start', /Unknown flag --disocver/.test((await page.textContent('[data-testid="parse-error"]')) ?? '') && (await page.isDisabled('[data-testid="start"]')));

// Start is disabled while the gateway has a live run.
await page.fill('[data-testid="command"]', '/explore https://www.saucedemo.com/ --features login,cart');
await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-testid="start"]')?.disabled);
busyOverride = { run_id: 'busy-run-1', run_dir: 'output/x/busy-run-1', url: 'https://x/', started_at: new Date().toISOString() };
broadcastActive();
await page.waitForSelector('[data-testid="active-run"]');
check('C7. while the gateway reports a live run, Start is disabled with the reason naming the run id', (await page.isDisabled('[data-testid="start"]')) && (await page.textContent('[data-testid="start-blocker"]')) === 'a run is already in progress: busy-run-1');
busyOverride = null; broadcastActive();
await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-testid="start"]')?.disabled);

// SRS attach: client-side rejections, then a valid file.
const tmpFiles = path.join(root, 'files'); fs.mkdirSync(tmpFiles);
fs.writeFileSync(path.join(tmpFiles, 'setup.exe'), 'MZ');
fs.writeFileSync(path.join(tmpFiles, 'big.md'), Buffer.alloc(big, 97));
fs.writeFileSync(path.join(tmpFiles, 'requirements.md'), '# SRS\n\nR1 login works');
await page.setInputFiles('[data-testid="f-srs"]', path.join(tmpFiles, 'setup.exe'));
await page.waitForSelector('[data-testid="srs-error"]');
check('C8. the page rejects a .exe with the message naming the four allowed types', /Allowed: \.md, \.txt, \.pdf, \.docx\./.test((await page.textContent('[data-testid="srs-error"]')) ?? ''));
await page.setInputFiles('[data-testid="f-srs"]', path.join(tmpFiles, 'big.md'));
await page.waitForFunction(() => /cap is 2 MB/.test(document.querySelector('[data-testid="srs-error"]')?.textContent ?? ''));
check('C9. the page rejects a 3 MB file stating the 2 MB cap', /3\.0 MB; the cap is 2 MB/.test((await page.textContent('[data-testid="srs-error"]')) ?? ''));
await page.setInputFiles('[data-testid="f-srs"]', path.join(tmpFiles, 'requirements.md'));
await page.waitForFunction(() => /requirements\.md/.test(document.querySelector('[data-testid="srs-name"]')?.textContent ?? ''));
check('C10. a valid SRS attaches and the command box says it travels with the command', /requirements\.md/.test((await page.textContent('[data-testid="command-srs-note"]')) ?? ''));

// Start: the page navigates to the run and renders live from the stream.
const sentCommand = await page.inputValue('[data-testid="command"]');
await page.click('[data-testid="start"]');
await page.waitForSelector('[data-testid="run-detail"][data-live="true"]', { timeout: 15000 });
check('C11. Start sends exactly the displayed command with the SRS attached, and the page opens /runs/<run id>', received.length === 1 && received[0]!.content === sentCommand && (received[0]!.srs as { name: string }).name === 'requirements.md' && page.url().endsWith(`/runs/${runId}`), JSON.stringify({ received: received.map((r) => ({ content: r.content, srs: (r.srs as { name?: string } | undefined)?.name })), url: page.url() }));
const liveRail = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="rail-item"]')).map((r) => r.getAttribute('data-status')));
check('C12. the live rail carries pending and running statuses while the stream is in flight', liveRail.length === 6 && liveRail.some((s) => s === 'pending' || s === 'running' || s === 'done'), JSON.stringify(liveRail));
// The fake gateway drops every socket after DROP_AT events.
await page.waitForSelector('[data-testid="socket-lost"]', { timeout: 15000 });
const midRail = await page.evaluate(() => ({ statuses: Array.from(document.querySelectorAll('[data-testid="rail-item"]')).map((r) => r.getAttribute('data-status')), events: document.querySelectorAll('[data-testid="event-row"]').length, log: document.querySelector('[data-testid="run-log"]')?.textContent ?? '' }));
check('C13. when the socket drops mid-run the page says so and offers reconnect; the panels show the stream so far (plan done, explore running)', midRail.statuses[1] === 'done' && midRail.statuses[2] === 'running' && midRail.events === DROP_AT && /scenarios planned/.test(midRail.log), JSON.stringify(midRail));
await page.click('[data-testid="reconnect"]');
await page.waitForSelector('[data-testid="caught-up"]', { timeout: 15000 });
check('C14. after reconnect the page catches up from the run folder\'s events.jsonl', /Caught up from the run folder: 9 stored events/.test((await page.textContent('[data-testid="caught-up"]')) ?? ''), (await page.textContent('[data-testid="caught-up"]')) ?? '');
await page.waitForSelector('[data-testid="run-detail"]:not([data-live])', { timeout: 20000 });
await page.waitForSelector('[data-testid="stage-view"][data-live="false"]');
const afterLive = await page.evaluate(() => ({
  html: document.querySelector('[data-testid="stage-view"]')?.innerHTML ?? '',
  statuses: Array.from(document.querySelectorAll('[data-testid="rail-item"]')).map((r) => r.getAttribute('data-status')),
  subtitle: document.querySelector('[data-testid="scenarios-subtitle"]')?.textContent ?? '',
  findingLabel: document.querySelector('[data-testid="finding"]')?.textContent ?? '',
  railTruncate: Array.from(document.querySelectorAll('[data-testid="rail-stat"]')).some((s) => s.className.includes('truncate')),
  srsArtifact: Array.from(document.querySelectorAll('[data-testid="artifact-link"]')).some((a) => a.getAttribute('data-kind') === 'srs'),
  events: document.querySelectorAll('[data-testid="event-row"]').length,
  log: document.querySelector('[data-testid="run-log"]') !== null,
}));
check('C15. when run_report arrives the page renders the report: rail statuses come from the report, no pending or running left', afterLive.statuses.length === 6 && !afterLive.statuses.some((s) => s === 'pending' || s === 'running') && afterLive.statuses[5] === 'attention', JSON.stringify(afterLive.statuses));
check('C16. polish: scenarios subtitle reads "N recorded", the finding card says "URL at the time", rail stats do not truncate', afterLive.subtitle === '2 recorded' && /URL at the time/.test(afterLive.findingLabel) && !/What happened/.test(afterLive.findingLabel) && !afterLive.railTruncate, JSON.stringify({ subtitle: afterLive.subtitle, finding: afterLive.findingLabel.slice(0, 120) }));
check('C17. the uploaded SRS is listed as an artifact of kind srs; the stored events and the log remain', afterLive.srsArtifact && afterLive.events === liveEvents.length && afterLive.log);
await page.goto(`${base}/runs/${runId}#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="stage-view"][data-live="false"]');
const historyHtml = await page.evaluate(() => document.querySelector('[data-testid="stage-view"]')?.innerHTML ?? '');
check('C18. the live rendering after run_report is byte-identical to the history view of the same report', afterLive.html.length > 1000 && afterLive.html === historyHtml, `live ${afterLive.html.length} chars vs history ${historyHtml.length} chars`);
check('C19. events.jsonl in the run folder holds every streamed event', readRunEvents(runDir).length === liveEvents.length);
check('C20. zero console errors', errors.filter((e) => !/404|WebSocket|Failed to load resource/.test(e)).length === 0, errors.join(' | '));

await browser.close();
for (const c of wss.clients) c.terminate();
await new Promise<void>((r) => wss.close(() => server.close(() => r())));
db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the Terminal composer and the raw command share one parser, SRS uploads land in the run folder with the stated rules, Start is disabled with a reason, and a live run renders identically to its history view once the report lands.');
