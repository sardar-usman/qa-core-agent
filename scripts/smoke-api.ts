/**
 * Locks the REST API (dashboard v2 plan, section 6; PR A GET routes plus
 * POST /api/reindex) and the static serving:
 *   - every /api route rejects a request without the token (401), accepts
 *     Authorization: Bearer and ?token=
 *   - responses equal the index: project cards sum the runs columns, the runs
 *     list filters by project and status, a run's report is the file on disk,
 *     the zip streams with the right headers
 *   - report and zip paths are served only from inside the project root
 *   - POST /api/reindex re-scans and returns counts
 *   - static: /legacy serves the single-file UI, a missing dist gets a build
 *     hint, a built dist serves assets with SPA fallback and blocks traversal
 * Runs on a real http server on an ephemeral port. No browser, no model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDatabase } from '../src/server/db/migrate.js';
import { indexOutput } from '../src/server/db/indexer.js';
import { createApiHandler } from '../src/server/api.js';
import { createStaticHandler } from '../src/server/static.js';
import { newRunId } from '../src/agent/output-layout.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-api-'));
const output = path.join(root, 'output');
function report(url: string, startedAt: string, shipped: number, planned: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url, language: 'ts', startedAt, finishedAt: startedAt, steps: 3,
    scenarios: Array.from({ length: shipped }, (_, i) => ({ name: `s${i}`, feature: 'login', category: 'happy', steps: [] })),
    cascadeStats: {}, cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 1, plannerUsd: 0.1, criticUsd: 0.05 },
    plan: Array.from({ length: planned }, (_, i) => ({ name: `p${i}`, category: 'happy', rationale: 'r' })),
    reconciliation: { planned, generated: shipped, dropped: [], incomplete: [], findings: [], skipped: [], accountedFor: shipped, added: 0, balanced: true, stable: shipped, recovered: 0, flaky: 0, broken: 0 },
    ...extra,
  };
}
const now = new Date();
const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 2, 12)).toISOString();
const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12)).toISOString();
const a1 = newRunId(new Date(lastMonth), 'a1'); const a2 = newRunId(new Date(thisMonth), 'a2'); const b1 = newRunId(new Date(thisMonth), 'b1');
for (const [slug, id, rep, files] of [
  ['saucedemo-com', a1, report('https://www.saucedemo.com/', lastMonth, 3, 4), { 'saucedemo-automation-framework.zip': 'PKzipbytes' }],
  ['saucedemo-com', a2, report('https://www.saucedemo.com/', thisMonth, 2, 5, { stopped: { kind: 'cost_ceiling', reason: 'ceiling' } }), { 'checkpoint.json': '{}' }],
  ['shop-example', b1, report('https://shop.example/', thisMonth, 0, 2), {}],
] as Array<[string, string, Record<string, unknown>, Record<string, string>]>) {
  const dir = path.join(output, slug, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-report.json'), JSON.stringify(rep));
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, k), v);
}
fs.writeFileSync(path.join(root, 'secret.txt'), 'nope');

const db = openDatabase(path.join(root, 'data', 'qa-core.sqlite'));
indexOutput(db, root);
const TOKEN = 't0k3n';
let reindexCalls = 0;
const api = createApiHandler({ db, root, token: TOKEN, reindex: () => { reindexCalls++; return indexOutput(db, root); } });
const distDir = path.join(root, 'dashboard', 'dist');
const legacyFile = path.join(root, 'qa-core-ui.html');
fs.writeFileSync(legacyFile, '<!doctype html><title>legacy</title>');
const statik = createStaticHandler({ distDir, legacyFile });
const server = http.createServer(async (req, res) => {
  if (await api(req, res)) return;
  if (statik(req, res)) return;
  res.writeHead(404); res.end('not found');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const get = async (p: string, headers: Record<string, string> = {}) => {
  const res = await fetch(base + p, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, text: buf.toString('utf8'), buf, json: () => JSON.parse(buf.toString('utf8')) as Record<string, unknown> };
};
const auth = { Authorization: `Bearer ${TOKEN}` };

/* ─── auth ─── */
for (const p of ['/api/projects', '/api/projects/saucedemo-com', '/api/runs', `/api/runs/${a1}`, `/api/runs/${a1}/report`, `/api/runs/${a1}/zip`]) {
  const r = await get(p);
  check(`A. ${p} rejects a request without the token`, r.status === 401 && /unauthorized/.test(r.text), String(r.status));
}
check('B. POST /api/reindex rejects without the token', (await fetch(base + '/api/reindex', { method: 'POST' })).status === 401);
check('C. a wrong bearer token is rejected', (await get('/api/projects', { Authorization: 'Bearer nope' })).status === 401);
check('D. ?token= is accepted like the WebSocket', (await get(`/api/projects?token=${TOKEN}`)).status === 200);

/* ─── projects ─── */
const projects = (await get('/api/projects', auth)).json().projects as Array<Record<string, unknown>>;
const sauce = projects.find((p) => p.id === 'saucedemo-com')!;
const shop = projects.find((p) => p.id === 'shop-example')!;
check('E. /api/projects lists both host projects', projects.length === 2 && !!sauce && !!shop, JSON.stringify(projects.map((p) => p.id)));
check('F. project card sums runs, lifetime shipped and spend from the runs rows', sauce.runs === 2 && sauce.shipped === 5 && Math.abs(Number(sauce.spend_total) - 2.3) < 1e-9, JSON.stringify(sauce));
check('G. spend this month counts only runs started this month', Math.abs(Number(sauce.spend_month) - 1.15) < 1e-9 && Math.abs(Number(shop.spend_month) - 1.15) < 1e-9, JSON.stringify([sauce.spend_month, shop.spend_month]));
check('H. last run is the newest by start time with its status', (sauce.last_run as Record<string, unknown>).id === a2 && (sauce.last_run as Record<string, unknown>).status === 'stopped');
check('I. open findings and coverage series are zero/empty without findings or SRS runs', sauce.open_findings === 0 && Array.isArray(sauce.coverage_series) && (sauce.coverage_series as unknown[]).length === 0);
const detail = (await get('/api/projects/saucedemo-com', auth)).json();
check('J. /api/projects/:id returns summary, trend (oldest first) and open findings', (detail.summary as Record<string, unknown>).runs === 2 && (detail.trend as Array<Record<string, unknown>>).length === 2 && (detail.trend as Array<Record<string, unknown>>)[0]?.run_id === a1 && Array.isArray(detail.open_findings));
check('K. unknown project is 404', (await get('/api/projects/nope', auth)).status === 404);

/* ─── runs ─── */
const runsAll = (await get('/api/runs', auth)).json().runs as Array<Record<string, unknown>>;
check('L. /api/runs lists every run newest first with the project name joined', runsAll.length === 3 && runsAll[0]?.project_name !== undefined && String(runsAll[0]?.started_at) >= String(runsAll[2]?.started_at), JSON.stringify(runsAll.map((r) => r.id)));
const runsSauce = (await get('/api/runs?project_id=saucedemo-com', auth)).json().runs as Array<Record<string, unknown>>;
check('M. project_id filter', runsSauce.length === 2 && runsSauce.every((r) => r.project_id === 'saucedemo-com'));
const runsStopped = (await get('/api/runs?status=stopped&limit=1', auth)).json().runs as Array<Record<string, unknown>>;
check('N. status filter and limit', runsStopped.length === 1 && runsStopped[0]?.id === a2 && runsStopped[0]?.checkpoint_path === `output/saucedemo-com/${a2}/checkpoint.json`);
const one = (await get(`/api/runs/${a1}`, auth)).json().run as Record<string, unknown>;
check('O. /api/runs/:id is the index row with the report numbers', one.shipped === 3 && one.planned === 4 && Math.abs(Number(one.cost_total) - 1.15) < 1e-9 && one.status === 'completed');
const rep = await get(`/api/runs/${a1}/report`, auth);
check('P. /api/runs/:id/report is the run-report file byte for byte', rep.status === 200 && rep.text === fs.readFileSync(path.join(output, 'saucedemo-com', a1, 'run-report.json'), 'utf8') && /application\/json/.test(rep.headers.get('content-type') ?? ''));
const zip = await get(`/api/runs/${a1}/zip`, auth);
check('Q. /api/runs/:id/zip streams the zip with attachment headers', zip.status === 200 && zip.headers.get('content-type') === 'application/zip' && /saucedemo-automation-framework\.zip/.test(zip.headers.get('content-disposition') ?? '') && zip.buf.toString('utf8') === 'PKzipbytes');
check('R. a run without a zip is 404 on /zip', (await get(`/api/runs/${b1}/zip`, auth)).status === 404);
check('S. unknown run is 404, a hostile id is 400', (await get('/api/runs/nope', auth)).status === 404 && (await get('/api/runs/..%2F..%2Fetc', auth)).status === 400);
// Path validation: a tampered report_path never escapes the root.
db.prepare('UPDATE runs SET report_path = ? WHERE id = ?').run('../secret.txt', b1);
check('T. a report path outside the root is refused even when the index says so', (await get(`/api/runs/${b1}/report`, auth)).status === 404);
db.prepare('UPDATE runs SET report_path = ? WHERE id = ?').run('secret.txt', b1);
check('U. a report path inside the root but outside output/ is still served only if it exists as recorded (root-relative)', (await get(`/api/runs/${b1}/report`, auth)).status === 200 && (await get(`/api/runs/${b1}/report`, auth)).text === 'nope');
indexOutput(db, root);

/* ─── reindex ─── */
const re = await fetch(base + '/api/reindex', { method: 'POST', headers: auth });
const reBody = await re.json() as { ok: boolean; result: { runs: number } };
check('V. POST /api/reindex re-scans and returns counts', re.status === 200 && reBody.ok && reBody.result.runs === 3 && reindexCalls === 1);
check('W. unknown /api route is 404 JSON', (await get('/api/nothing', auth)).status === 404);

/* ─── static ─── */
check('X. /legacy serves the single-file UI', (await get('/legacy')).text.includes('<title>legacy</title>'));
const hint = await get('/');
check('Y. without a built dist, / explains how to build', hint.status === 200 && /npm run dashboard:build/.test(hint.text));
fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><div id="root">app</div>');
fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log(1)');
check('Z. a built dist serves index.html at /', (await get('/')).text.includes('id="root"'));
const asset = await get('/assets/app.js');
check('AA. assets are served with their type and immutable caching', asset.status === 200 && /javascript/.test(asset.headers.get('content-type') ?? '') && /immutable/.test(asset.headers.get('cache-control') ?? ''));
check('AB. an app route falls back to index.html (SPA)', (await get('/runs/abc')).text.includes('id="root"'));
check('AC. traversal out of dist is not served', !(await get('/../secret.txt')).text.includes('nope') && !(await get('/assets/..%2F..%2F..%2Fsecret.txt')).text.includes('nope'));

server.close();
db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: every /api route needs the gateway token, responses equal the index, files are served only from inside the root, and the dashboard is static-served with /legacy alongside.');
