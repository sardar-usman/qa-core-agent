/**
 * Locks Resume and Regenerate from Run Detail (dashboard v2 plan, PR E1):
 *   - Resume appears only on a stopped run (checkpoint.json present),
 *     Regenerate framework only on a completed run, neither on a legacy record
 *   - both send slash commands the gateway parses through the same request
 *     layer as the Terminal: /resume <checkpoint> [--ceiling N], /transcribe <report>
 *   - both are disabled with the reason while any run is live
 *   - Resume switches to the live view of the resumed run (same run id);
 *     Regenerate refreshes the artifacts from disk when the new zip lands
 * A fake gateway speaking the real message shapes over the real API and
 * static handlers; the run itself is scripted. No model, no live run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { chromium } from 'playwright';
import { openDatabase } from '../src/server/db/migrate.js';
import { indexOutput } from '../src/server/db/indexer.js';
import { createApiHandler } from '../src/server/api.js';
import { createStaticHandler } from '../src/server/static.js';
import { parseGatewayCommand } from '../src/server/commands.js';
import { loadReportForUi } from '../src/server/runs.js';
import { newRunId } from '../src/agent/output-layout.js';
import { resumeCommand, transcribeCommand } from '../dashboard/src/lib/command.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

/* ─── pure: the commands the buttons send go through the gateway's parser ─── */
const cpPath = 'output/shop-example/20260912T100000Z-abc123/checkpoint.json';
const rp = 'output/shop-example/20260910T100000Z-def456/run-report.json';
const r1 = parseGatewayCommand(resumeCommand(cpPath, '4'), { lang: 'ts' });
check('A. resumeCommand parses to an explore request carrying the checkpoint and the ceiling override', r1.kind === 'explore' && r1.request.resume === cpPath && r1.request.env.QA_CORE_COST_CEILING === '4', JSON.stringify(r1));
const r2 = parseGatewayCommand(resumeCommand(cpPath), { lang: 'ts' });
check('A2. without a ceiling the resume request has no env override', r2.kind === 'explore' && r2.request.resume === cpPath && Object.keys(r2.request.env).length === 0);
const t1 = parseGatewayCommand(transcribeCommand(rp), { lang: 'ts' });
check('A3. transcribeCommand parses to a transcribe of that report', t1.kind === 'transcribe' && t1.reportPath === rp);
check('A4. a path with a space is quoted so it stays one token', parseGatewayCommand(transcribeCommand('output/my run/run-report.json'), { lang: 'ts' }).kind === 'transcribe');

/* ─── fixture ─── */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-resume-'));
const output = path.join(root, 'output');
const mk = (url: string, startedAt: string, shipped: number, planned: number, extra: Record<string, unknown> = {}) => ({
  url, language: 'ts', startedAt, finishedAt: new Date(Date.parse(startedAt) + 100_000).toISOString(), steps: 10,
  scenarios: Array.from({ length: shipped }, (_, i) => ({ name: `scenario ${i + 1}`, feature: 'login', category: 'happy', steps: [{ kind: 'navigate', url }] })),
  cascadeStats: {}, cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 1, plannerUsd: 0.002, criticUsd: 0.009, repairUsd: 0 },
  plan: Array.from({ length: planned }, (_, i) => ({ name: `scenario ${i + 1}`, category: 'happy', rationale: 'r', feature: 'login' })),
  reconciliation: { planned, generated: shipped, dropped: [], incomplete: Array.from({ length: planned - shipped }, (_, i) => ({ name: `scenario ${shipped + i + 1}`, reason: 'never explored' })), findings: [], skipped: [], accountedFor: planned, added: 0, balanced: true, stable: shipped, recovered: 0, flaky: 0, broken: 0 },
  ...extra,
});
const stoppedId = newRunId(new Date('2026-09-12T10:00:00Z'), 'stop');
const doneId = newRunId(new Date('2026-09-10T10:00:00Z'), 'done');
const stoppedDir = path.join(output, 'shop-example', stoppedId);
const doneDir = path.join(output, 'shop-example', doneId);
fs.mkdirSync(stoppedDir, { recursive: true }); fs.mkdirSync(doneDir, { recursive: true });
fs.writeFileSync(path.join(stoppedDir, 'run-report.json'), JSON.stringify(mk('https://shop.example/', '2026-09-12T10:00:00.000Z', 1, 3, { stopped: { kind: 'cost_ceiling', reason: 'cost ceiling hit' } })));
fs.writeFileSync(path.join(stoppedDir, 'checkpoint.json'), JSON.stringify({ version: 1 }));
fs.writeFileSync(path.join(stoppedDir, 'shop-automation-framework.zip'), 'PK');
fs.writeFileSync(path.join(doneDir, 'run-report.json'), JSON.stringify(mk('https://shop.example/', '2026-09-10T10:00:00.000Z', 2, 2)));
fs.writeFileSync(path.join(doneDir, 'shop-automation-framework.zip'), 'PK');
fs.mkdirSync(path.join(root, '.qa-core', 'sites'), { recursive: true });
fs.writeFileSync(path.join(root, '.qa-core', 'sites', 'demoqa.com.json'), JSON.stringify({ host: 'demoqa.com', recentRuns: [{ at: '2026-06-30T15:00:00.000Z', url: 'https://demoqa.com/frames', scenarios: 1, cost: 0.6, model: 'claude-opus-4-7', durationSec: 255 }] }));
const db = openDatabase(path.join(root, 'data', 'qa-core.sqlite'));
indexOutput(db, root);
const legacyId = (db.prepare("SELECT id FROM runs WHERE status = 'legacy'").get() as { id: string }).id;
const checkpointRel = `output/shop-example/${stoppedId}/checkpoint.json`;
const reportRel = `output/shop-example/${doneId}/run-report.json`;

/* ─── fake gateway ─── */
const TOKEN = 'resume-token';
const repo = process.cwd();
const dist = path.join(repo, 'dashboard', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dashboard/dist is missing. Run `npm run dashboard:build` first.'); process.exit(1); }
const apiHandler = createApiHandler({ db, root, token: TOKEN });
const statik = createStaticHandler({ distDir: dist, legacyFile: path.join(repo, 'qa-core-ui.html') });
const server = http.createServer(async (req, res) => { if (await apiHandler(req, res)) return; if (statik(req, res)) return; res.writeHead(404); res.end(); });
const wss = new WebSocketServer({ server });
const send = (ws: WebSocket, p: object) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(p)); };
let busy: { run_id: string; run_dir: string; url: string; started_at: string } | null = null;
const received: Array<Record<string, unknown>> = [];
const broadcastActive = () => { for (const c of wss.clients) send(c, { type: 'active_run', run: busy }); };
wss.on('connection', (ws) => {
  send(ws, { type: 'settings', settings: [] });
  send(ws, { type: 'active_run', run: busy });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (msg.type === 'active_run') { send(ws, { type: 'active_run', run: busy }); return; }
    if (msg.type !== 'message') return;
    received.push(msg);
    const cmd = parseGatewayCommand(String(msg.content), { lang: 'ts' });
    if (cmd.kind === 'explore' && cmd.request.resume) {
      const runId = path.basename(path.dirname(cmd.request.resume));
      busy = { run_id: runId, run_dir: path.dirname(cmd.request.resume), url: 'https://shop.example/', started_at: new Date().toISOString() };
      broadcastActive();
      send(ws, { run_id: runId, type: 'run_started', run_dir: busy.run_dir, command: 'resume', request: { url: 'https://shop.example/', lang: 'ts', pom: true, features: [], srs: null, discover: false, urls: [], resume: cmd.request.resume, stabilize: true, stabilizeAttempts: 3, env: cmd.request.env }, settings: [] });
      send(ws, { run_id: runId, text: '▸ Resuming https://shop.example/' });
      send(ws, { run_id: runId, type: 'event', event: { type: 'tool_call', name: 'begin_scenario', input: { name: 'scenario 2' } } });
      return;
    }
    if (cmd.kind === 'transcribe') {
      // The regenerate lands a new zip in the run folder, then the report announces it.
      const dir = path.dirname(path.resolve(root, cmd.reportPath));
      fs.writeFileSync(path.join(dir, 'shop-regenerated-automation-framework.zip'), 'PK2');
      const loaded = loadReportForUi(root, cmd.reportPath);
      send(ws, { text: `▸ Transcribing ${cmd.reportPath} (no exploration, no model call)` });
      send(ws, { type: 'run_report', report: loaded.report, outcome: { kind: 'framework', reportPath: cmd.reportPath, checkpointPath: null, resumeHint: null, summary: [], diagnosis: null, regenerated: true } });
      send(ws, { type: 'framework_zip', filename: 'shop-regenerated-automation-framework.zip', base64: Buffer.from('PK2').toString('base64'), sizeBytes: 3, fileCount: 1, scenarios: 2, runReportPath: cmd.reportPath });
      return;
    }
    send(ws, { text: `✗ unexpected command ${String(msg.content)}` });
    send(ws, { type: 'run_failed', error: 'unexpected command' });
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

/* ─── page ─── */
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const actions = async (id: string) => {
  await page.goto(`${base}/runs/${id}#token=${TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="run-detail"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="gateway-status"]')?.textContent?.includes('connected'));
  return page.evaluate(() => ({ resume: !!document.querySelector('[data-testid="resume"]'), regenerate: !!document.querySelector('[data-testid="regenerate"]'), resumeDisabled: (document.querySelector('[data-testid="resume"]') as HTMLButtonElement | null)?.disabled ?? null, regenDisabled: (document.querySelector('[data-testid="regenerate"]') as HTMLButtonElement | null)?.disabled ?? null, blocker: document.querySelector('[data-testid="actions-blocker"]')?.textContent ?? null }));
};
const onStopped = await actions(stoppedId);
check('B. a stopped run shows Resume and not Regenerate, enabled with no run live', onStopped.resume && !onStopped.regenerate && onStopped.resumeDisabled === false && onStopped.blocker === null, JSON.stringify(onStopped));
const onDone = await actions(doneId);
check('C. a completed run shows Regenerate framework and not Resume', onDone.regenerate && !onDone.resume && onDone.regenDisabled === false, JSON.stringify(onDone));
const onLegacy = await actions(legacyId);
check('D. a legacy record shows neither', !onLegacy.resume && !onLegacy.regenerate, JSON.stringify(onLegacy));

// Disabled with the reason while any run is live.
busy = { run_id: 'busy-run-9', run_dir: 'output/x/busy-run-9', url: 'https://x/', started_at: new Date().toISOString() };
const onDoneBusy = await actions(doneId);
check('E. while a run is live, Regenerate is disabled and the reason names the run', onDoneBusy.regenDisabled === true && onDoneBusy.blocker === 'a run is already in progress: busy-run-9', JSON.stringify(onDoneBusy));
const onStoppedBusy = await actions(stoppedId);
check('F. while a run is live, Resume is disabled with the same reason', onStoppedBusy.resumeDisabled === true && onStoppedBusy.blocker === 'a run is already in progress: busy-run-9', JSON.stringify(onStoppedBusy));
busy = null;

// Regenerate: the command, then the artifacts refresh from disk.
await actions(doneId);
const zipsBefore = await page.$$eval('[data-testid="artifact-link"][data-kind="zip"]', (els) => els.map((e) => e.textContent ?? ''));
await page.click('[data-testid="regenerate"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="artifact-link"][data-kind="zip"]').length === 2, null, { timeout: 15000 });
const zipsAfter = await page.$$eval('[data-testid="artifact-link"][data-kind="zip"]', (els) => els.map((e) => e.textContent ?? ''));
const regenMsg = received.find((m) => String(m.content).startsWith('/transcribe'));
check('G. Regenerate sends /transcribe <run-report path> through the gateway parser', regenMsg?.content === transcribeCommand(reportRel) && parseGatewayCommand(String(regenMsg?.content), { lang: 'ts' }).kind === 'transcribe', JSON.stringify(regenMsg));
check('H. when the new zip lands the artifacts list refreshes from disk', zipsBefore.length === 1 && zipsAfter.length === 2 && zipsAfter.some((z) => /regenerated/.test(z)), JSON.stringify({ zipsBefore, zipsAfter }));

// Resume with a ceiling: the command, then the live view of the same run id.
await actions(stoppedId);
await page.fill('[data-testid="resume-ceiling"]', '4');
await page.click('[data-testid="resume"]');
await page.waitForSelector('[data-testid="run-detail"][data-live="true"]', { timeout: 15000 });
const resumeMsg = received.find((m) => String(m.content).startsWith('/resume'));
const parsedResume = parseGatewayCommand(String(resumeMsg?.content ?? ''), { lang: 'ts' });
check('I. Resume sends /resume <checkpoint path> --ceiling 4 through the gateway parser', resumeMsg?.content === resumeCommand(checkpointRel, '4') && parsedResume.kind === 'explore' && parsedResume.request.resume === checkpointRel && parsedResume.request.env.QA_CORE_COST_CEILING === '4', JSON.stringify(resumeMsg));
const liveHeader = await page.evaluate(() => ({ id: document.querySelector('[data-testid="detail-run-id"]')?.textContent, url: location.pathname, running: !!document.querySelector('[data-status="running"]') }));
check('J. the page switches to the live view of the resumed run, same run id', liveHeader.id === stoppedId && liveHeader.url === `/runs/${stoppedId}` && liveHeader.running, JSON.stringify(liveHeader));
check('K. zero console errors', errors.filter((e) => !/404|WebSocket/.test(e)).length === 0, errors.join(' | '));

await browser.close();
for (const c of wss.clients) c.terminate();
await new Promise<void>((r) => wss.close(() => server.close(() => r())));
db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: Resume and Regenerate appear only on the right statuses, send /resume and /transcribe through the gateway parser, and are disabled with the reason while a run is live.');
