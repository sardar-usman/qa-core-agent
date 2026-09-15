import 'dotenv/config';
import { execSync } from 'node:child_process';
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { explore } from '../agent/runtime.js';
import { generateFromStory } from '../agent/generate.js';
import { heal } from '../cli/heal.js';
import { transcribe } from '../agent/transcriber.js';
import { transcribePOM } from '../agent/pom.js';
import { parseFeatures } from '../agent/parse-features.js';
import { readRunSettings, type ExploreRequest } from '../agent/explore-request.js';
import { parseGatewayCommand } from './commands.js';
import { listRunsFromDisk, loadReportForUi, reportForUi } from './runs.js';
import { runExploreRequest, runTranscribeRequest, type FrameworkZip, type SrsUpload } from './run-explore.js';
import { eventForUi, readRunEvents } from './events.js';
import { listRunDirs } from '../agent/output-layout.js';
import { projectSrsUploadFor } from './project-srs.js';
import { openDatabase, DEFAULT_DB_PATH } from './db/migrate.js';
import { indexOutput, renderIndexResult } from './db/indexer.js';
import { createApiHandler } from './api.js';
import { createStaticHandler } from './static.js';

/**
 * QA-Core gateway.
 *
 * A thin WebSocket server that speaks the protocol [qa-core-ui.html] sends:
 * `{type: "message", content, model, lang, env?, srs?}`. The gateway parses
 * the slash command out of `content` (src/server/commands.ts), runs it
 * through the same request layer the CLI and MCP server use, and streams
 * progress back as JSON messages:
 *
 *   {text}                       a human-readable note for the chat
 *   {type:'settings', settings}  the env-driven run settings, on connect
 *   {type:'active_run', run}     the run in progress on this gateway (or null), on connect and on change
 *   {type:'run_started', ...}    the resolved request for the run header, with run_id and run_dir
 *   {type:'event', event}        every AgentEvent, for the live pipeline view
 *   {type:'run_report', report}  the final RunReport (traces stripped); also the
 *                                reply to a get_report request (fromHistory: true)
 *   {type:'catch_up', ...}       reply to a catch_up request: the run folder's events.jsonl
 *                                and, when finished, its run-report; the socket then watches the run
 *   {type:'framework_zip', ...}  the zipped framework, base64
 *   {type:'runs', runs}          run history from disk
 *
 * A dashboard socket that reconnects mid-run sends {type:'catch_up', run_id}
 * and gets the run folder's state back (never gateway memory), then receives
 * the remaining live messages as a watcher of that run.
 *
 * Run:  npm run gateway
 * Env:  QA_CORE_GATEWAY_PORT   (default 18789, matches the UI's default)
 *       QA_CORE_GATEWAY_TOKEN  (optional; clients pass `?token=` query)
 */

const PORT = Number(process.env.QA_CORE_GATEWAY_PORT ?? 18789);
const HOST = process.env.QA_CORE_GATEWAY_HOST ?? '127.0.0.1';
const TOKEN = process.env.QA_CORE_GATEWAY_TOKEN ?? '';
const ROOT = process.cwd();

interface IncomingMessage {
  /** 'message' for slash commands; 'list_runs' / 'get_settings' / 'get_report' / 'active_run' / 'watch' / 'catch_up' for state sync. */
  type?: string;
  /** For watch / catch_up: the run to follow. */
  run_id?: string;
  content?: string;
  agent?: string;
  model?: string;
  lang?: 'ts' | 'js';
  /** Per-run setting overrides from the dashboard, keyed by env name. */
  env?: Record<string, string>;
  /** An SRS document uploaded from the dashboard (md/txt/pdf/docx). */
  srs?: { name: string; base64: string };
  /** Use the named project's current SRS (output/<slug>/srs/); the run still gets its own copy. Ignored when `srs` is given. */
  srs_project?: string;
  /** For get_report: the run-report.json path, relative to the project root. */
  reportPath?: string;
}

function send(ws: WebSocket, payload: object): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function asLang(v: unknown): 'ts' | 'js' {
  return v === 'js' ? 'js' : 'ts';
}

function runId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function slugify(s: string, max = 40): string {
  return s.replace(/^https?:\/\//, '').replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max).toLowerCase() || 'run';
}

/**
 * Per-connection state. Each client gets its own busy flag so a single user
 * can't fire two long-running commands at the same time over the same socket.
 */
interface ConnectionState {
  busy: boolean;
}

/**
 * Per-run env overrides are applied to process.env for the duration of the
 * run, so only one explore may run per gateway process at a time. A second
 * connection asking to explore while one is active is told to wait.
 */
let activeExplores = 0;

/** The run in progress, announced to every client so a composer can disable Start with the reason. */
interface ActiveRun { run_id: string; run_dir: string; url: string; started_at: string }
let activeRun: ActiveRun | null = null;
function setActiveRun(run: ActiveRun | null): void {
  activeRun = run;
  for (const client of wss.clients) send(client, { type: 'active_run', run: activeRun });
}

/**
 * Sockets following a run they did not start (a dashboard tab that reconnected
 * mid-run). They receive the same run_started / event / run_report messages
 * as the requester, each tagged with run_id.
 */
const watchers = new Map<string, Set<WebSocket>>();
function watch(runId: string, ws: WebSocket): void {
  if (!watchers.has(runId)) watchers.set(runId, new Set());
  watchers.get(runId)!.add(ws);
}
function sendToRun(requester: WebSocket, runId: string | null, payload: object): void {
  const body = runId ? { run_id: runId, ...payload } : payload;
  send(requester, body);
  if (!runId) return;
  for (const w of watchers.get(runId) ?? []) if (w !== requester) send(w, body);
}

/** Locate a run directory by run id: the active run's, else output/<project>/<run-id>/ on disk. */
function runDirById(runId: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return null;
  if (activeRun?.run_id === runId) return activeRun.run_dir;
  const hit = listRunDirs(path.join(ROOT, 'output')).find((e) => e.runId === runId);
  return hit ? hit.dir : null;
}

/**
 * The index (dashboard v2 plan, section 5): files are truth, the database
 * is rebuilt from output/ on every start and refreshed after every run.
 */
const DB_PATH = process.env.QA_CORE_DB_PATH ?? path.join(ROOT, DEFAULT_DB_PATH);
const db = openDatabase(DB_PATH);
function reindex(): ReturnType<typeof indexOutput> {
  const result = indexOutput(db, ROOT);
  console.log(`  ${renderIndexResult(result)}`);
  return result;
}
reindex();

// One HTTP server: REST API under /api, the built dashboard at /, the legacy
// single-file UI at /legacy, and the WebSocket upgrade on any path (/ws for
// the dashboard, / for the legacy UI).
const api = createApiHandler({ db, root: ROOT, token: TOKEN, reindex, log: (line) => console.log(`  ${line}`), gateway: { host: HOST, port: PORT } });
const statik = createStaticHandler({ distDir: process.env.QA_CORE_DASHBOARD_DIST ?? path.join(ROOT, 'dashboard', 'dist'), legacyFile: process.env.QA_CORE_LEGACY_UI ?? path.join(ROOT, 'qa-core-ui.html') });
const server = http.createServer(async (req, res) => {
  try {
    if (await api(req, res)) return;
    if (statik(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end((err as Error).message);
  }
});
const wss = new WebSocketServer({ server });

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`✗ Port ${PORT} is already in use.`);
    console.error(`  Another gateway may already be running, or set QA_CORE_GATEWAY_PORT to a different port.`);
    process.exit(1);
  }
  console.error('Gateway error:', err);
  process.exit(1);
});

wss.on('connection', (ws, req) => {
  if (TOKEN) {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    if (url.searchParams.get('token') !== TOKEN) {
      ws.close(1008, 'invalid token');
      return;
    }
  }

  const state: ConnectionState = { busy: false };
  send(ws, { text: 'Connected to QA-Core gateway. Try `/explore <url>`, `/resume <checkpoint>`, `/transcribe <run-report>`, `/generate "<story>"`, or `/heal <spec-path>`.' });
  send(ws, { type: 'settings', settings: readRunSettings() });
  send(ws, { type: 'active_run', run: activeRun });
  ws.on('close', () => { for (const set of watchers.values()) set.delete(ws); });

  ws.on('message', async (raw) => {
    let msg: IncomingMessage;
    try { msg = JSON.parse(raw.toString()) as IncomingMessage; } catch { return; }

    if (msg.type === 'active_run') { send(ws, { type: 'active_run', run: activeRun }); return; }
    if (msg.type === 'watch' && msg.run_id) { watch(msg.run_id, ws); return; }
    // Catch up from the run folder, never from memory: events.jsonl as written
    // so far, plus the report when the run has finished.
    if (msg.type === 'catch_up' && msg.run_id) {
      const dir = runDirById(msg.run_id);
      if (!dir) { send(ws, { type: 'catch_up', run_id: msg.run_id, found: false, active: false, events: [], report: null, outcome: null }); return; }
      watch(msg.run_id, ws);
      const reportFile = path.join(dir, 'run-report.json');
      let loaded: ReturnType<typeof loadReportForUi> | null = null;
      if (fs.existsSync(reportFile)) { try { loaded = loadReportForUi(ROOT, path.relative(ROOT, reportFile)); } catch { loaded = null; } }
      send(ws, {
        type: 'catch_up', run_id: msg.run_id, found: true, active: activeRun?.run_id === msg.run_id, run_dir: path.relative(ROOT, dir),
        events: readRunEvents(dir), report: loaded?.report ?? null, outcome: loaded?.outcome ?? null,
      });
      return;
    }

    if (msg.type === 'list_runs') {
      try {
        send(ws, { type: 'runs', runs: listRunsFromDisk(ROOT) });
      } catch (err) {
        send(ws, { text: `✗ Could not read runs from disk: ${(err as Error).message}` });
      }
      return;
    }
    if (msg.type === 'get_settings') {
      send(ws, { type: 'settings', settings: readRunSettings() });
      return;
    }
    // History "view": the full report for a past run, rendered as the same
    // six panels a live run shows.
    if (msg.type === 'get_report') {
      try {
        const loaded = loadReportForUi(ROOT, String(msg.reportPath ?? ''));
        send(ws, { type: 'run_report', fromHistory: true, ...loaded });
      } catch (err) {
        send(ws, { text: `✗ ${(err as Error).message}` });
      }
      return;
    }

    const content = (msg.content ?? '').trim();
    if (!content) return;

    if (state.busy) {
      send(ws, { text: '⏳ Already running a command on this connection. Wait for it to finish.' });
      return;
    }

    state.busy = true;
    try {
      await dispatch(content, msg, ws);
      // Run completion: refresh the index and the legacy history list.
      try { reindex(); } catch (err) { console.error('  index refresh failed:', (err as Error).message); }
      try { send(ws, { type: 'runs', runs: listRunsFromDisk(ROOT) }); } catch { /* best-effort */ }
    } catch (err) {
      send(ws, { text: `✗ ${(err as Error).message}` });
      send(ws, { type: 'run_failed', error: (err as Error).message });
    } finally {
      state.busy = false;
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`QA-Core gateway listening on http://${HOST}:${PORT}`);
  console.log(`  dashboard  http://${HOST}:${PORT}/        (legacy UI at /legacy)`);
  console.log(`  api        http://${HOST}:${PORT}/api/    websocket ws://${HOST}:${PORT}/ws`);
  console.log(TOKEN ? '  (token required: Authorization: Bearer <token> or ?token=)' : '  (no token, local use only)');
  console.log(`  index      ${path.relative(ROOT, DB_PATH)}`);
});

/* ─────────────────── Dispatch ─────────────────── */

async function dispatch(content: string, msg: IncomingMessage, ws: WebSocket): Promise<void> {
  const lang = asLang(msg.lang);
  const cmd = parseGatewayCommand(content, { lang, ...(msg.env ? { env: msg.env } : {}) });

  switch (cmd.kind) {
    case 'reply':
      send(ws, { text: cmd.text });
      return;
    case 'explore': {
      for (const n of cmd.notes) send(ws, { text: n });
      const request = cmd.request;
      if (cmd.naturalHint) {
        const parsed = await parseFeatures({ naturalInput: cmd.naturalHint });
        request.features = parsed.features;
      }
      // An attached SRS travels with the message; the request layer saves it
      // into the run directory (run-explore.ts, saveSrsUpload).
      let srsUpload = msg.srs;
      if (!srsUpload && typeof msg.srs_project === 'string' && /^[a-z0-9-]+$/.test(msg.srs_project)) {
        const fromProject = projectSrsUploadFor(ROOT, msg.srs_project);
        if (!fromProject) { send(ws, { text: `✗ Project ${msg.srs_project} has no requirements document.` }); send(ws, { type: 'run_failed', error: `project ${msg.srs_project} has no SRS` }); return; }
        srsUpload = fromProject;
        send(ws, { text: `Note: using the project SRS ${fromProject.name} (a copy is saved into the run folder).` });
      }
      await handleExplore(request, msg.model, ws, srsUpload);
      return;
    }
    case 'transcribe':
      handleTranscribe(cmd.reportPath, cmd.outDir, ws);
      return;
    case 'generate':
      await handleGenerate(cmd.story, lang, msg.model, ws);
      return;
    case 'heal':
      await handleHeal(cmd.specPath, msg.model, ws);
      return;
    case 'eval':
      await handleEval(ws, cmd.pom);
      return;
  }
}

/* ─────────────────── /explore + /resume ─────────────────── */

async function handleExplore(request: ExploreRequest, model: string | undefined, ws: WebSocket, srsUpload?: SrsUpload): Promise<void> {
  if (activeExplores > 0) {
    const reason = `a run is already in progress${activeRun ? `: ${activeRun.run_id}` : ''}`;
    send(ws, { text: `⏳ Another explore run is active on this gateway (${reason}). Wait for it to finish (per-run settings apply to one run at a time).` });
    send(ws, { type: 'run_failed', error: reason });
    return;
  }
  activeExplores++;
  let runId: string | null = null;
  try {
    const outcome = await runExploreRequest({
      request, projectRoot: ROOT, source: 'dashboard',
      ...(model ? { model } : {}),
      ...(srsUpload ? { srsUpload } : {}),
      // run_started goes out once the run directory is known, so it carries
      // the run id the dashboard navigates to (/runs/<run id>).
      onPrepared: (p) => {
        runId = p.runId;
        setActiveRun({ run_id: p.runId, run_dir: p.outDir, url: p.url, started_at: new Date().toISOString() });
        sendToRun(ws, runId, {
          type: 'run_started',
          run_dir: path.relative(ROOT, p.outDir),
          command: p.resume ? 'resume' : 'explore',
          request: {
            url: p.url, lang: request.lang, pom: request.pom, features: request.features,
            srs: request.srs ?? (srsUpload ? srsUpload.name : null), discover: request.discover, urls: request.urls, resume: request.resume ?? null,
            stabilize: request.stabilize, stabilizeAttempts: request.stabilizeAttempts, env: request.env,
          },
          settings: readRunSettings({ ...process.env, ...request.env }),
        });
      },
      onNote: (text) => sendToRun(ws, runId, { text }),
      onEvent: (e) => {
        sendToRun(ws, runId, { type: 'event', event: eventForUi(e) });
        if (e.type === 'message' && e.text.trim().length > 0 && e.text.length < 600 && !e.text.startsWith('Run stopped:')) {
          sendToRun(ws, runId, { text: e.text.trim() });
        }
      },
    });

    // Index the finished run BEFORE announcing the report, so a dashboard
    // that fetches /api/runs/<id>/detail on run_report finds it.
    try { reindex(); } catch (err) { console.error('  index refresh failed:', (err as Error).message); }
    sendToRun(ws, runId, {
      type: 'run_report',
      report: reportForUi(outcome.report),
      outcome: {
        kind: outcome.kind,
        reportPath: outcome.reportPath,
        checkpointPath: outcome.checkpointPath ?? null,
        resumeHint: outcome.resumeHint ?? null,
        summary: outcome.summary,
        diagnosis: outcome.diagnosis ?? null,
      },
    });

    if (outcome.kind === 'empty') {
      send(ws, { text: ['✗ No framework was written: 0 scenarios survived the pipeline.', ...(outcome.diagnosis ?? [])].join('\n') });
      if (outcome.resumeHint) send(ws, { text: outcome.resumeHint });
      return;
    }
    const zipLine = outcome.zip ? ` (${outcome.zip.scenarios} scenarios, ${outcome.zip.fileCount} files)` : '';
    send(ws, { text: [`**Done.** Wrote ${outcome.kind === 'framework' ? 'framework' : 'spec'} to \`${path.relative(ROOT, outcome.outDir)}\`${zipLine}.`, ...outcome.summary].join('\n') });
    if (outcome.zip) sendZip(ws, outcome.zip, outcome.reportPath);
    else if (outcome.specPath) send(ws, { text: fs.readFileSync(outcome.specPath, 'utf8') });
    if (outcome.resumeHint) send(ws, { text: outcome.resumeHint });
  } catch (err) {
    if (runId) sendToRun(ws, runId, { type: 'run_failed', error: (err as Error).message });
    throw err;
  } finally {
    activeExplores--;
    if (runId) watchers.delete(runId);
    setActiveRun(null);
  }
}

function sendZip(ws: WebSocket, zip: FrameworkZip, runReportPath: string): void {
  send(ws, {
    type: 'framework_zip',
    filename: zip.filename,
    base64: zip.buffer.toString('base64'),
    sizeBytes: zip.sizeBytes,
    fileCount: zip.fileCount,
    scenarios: zip.scenarios,
    runReportPath,
  });
}

/* ─────────────────── /transcribe ─────────────────── */

function handleTranscribe(reportPath: string, outDir: string | undefined, ws: WebSocket): void {
  send(ws, { text: `▸ Transcribing ${reportPath} (no exploration, no model call)` });
  const outcome = runTranscribeRequest({ reportPath, ...(outDir ? { outDir } : {}) }, ROOT, 'dashboard');
  for (const n of outcome.notes) send(ws, { text: n });
  send(ws, { type: 'run_report', report: reportForUi(outcome.report), outcome: { kind: 'framework', reportPath, checkpointPath: null, resumeHint: null, summary: [], diagnosis: null, regenerated: true } });
  sendZip(ws, outcome.zip, reportPath);
}

/* ─────────────────── /generate ─────────────────── */

async function handleGenerate(story: string, lang: 'ts' | 'js', model: string | undefined, ws: WebSocket): Promise<void> {
  send(ws, { text: `▸ Generating spec from story (${lang})` });

  const result = await generateFromStory({ story, language: lang, model });
  const outDir = path.join(process.cwd(), 'output', `${runId()}-generate`);
  fs.mkdirSync(outDir, { recursive: true });
  const file = `${slugify(result.feature)}.spec.${lang}`;
  const specPath = path.join(outDir, file);
  const header = '// UNVERIFIED — generated from a user story without browser execution.\n// Run `npx playwright test` against it before trusting the output.\n\n';
  fs.writeFileSync(specPath, header + result.spec + (result.spec.endsWith('\n') ? '' : '\n'));

  send(ws, {
    text: `**Done.** ${result.scenarios} scenarios · wrote \`${path.relative(process.cwd(), specPath)}\`.\nThis spec is **UNVERIFIED** — run it before trusting it.`,
  });
  send(ws, { text: fs.readFileSync(specPath, 'utf8') });
}

/* ─────────────────── /heal ─────────────────── */

async function handleHeal(specArg: string, model: string | undefined, ws: WebSocket): Promise<void> {
  const specPath = path.resolve(process.cwd(), specArg);
  if (!fs.existsSync(specPath)) {
    send(ws, { text: `✗ Spec not found: ${specArg}` });
    return;
  }
  send(ws, { text: `▸ Healing ${path.relative(process.cwd(), specPath)}` });

  const result = await heal({
    specPath,
    onEvent: (e) => {
      switch (e.type) {
        case 'scanned':
          send(ws, { text: `Scanned ${e.total} locator(s) across ${e.files} file(s)` });
          break;
        case 'opened_page':
          send(ws, { text: `Opened ${e.url}` });
          break;
        case 'healing':
          send(ws, { text: `→ broken \`${e.selector}\`` });
          break;
        case 'healed':
          send(ws, { text: `✓ healed → \`${e.new}\` (level=${e.level})` });
          break;
        case 'unhealed':
          send(ws, { text: `✗ unhealable \`${e.selector}\` — ${e.reason}` });
          break;
      }
    },
  });

  send(ws, {
    text: `**Done.** ${result.intact} intact · ${result.healed.length} healed · ${result.unhealable.length} unhealable (of ${result.scanned}).`,
  });
  if (result.healedPath) {
    send(ws, { text: fs.readFileSync(result.healedPath, 'utf8') });
  }
}

/* ─────────────────── /eval ─────────────────── */

interface EvalRow {
  site: string;
  url: string;
  scenarios: number;
  tests: number;
  passed: number;
  failed: number;
  flaky: number;
  passRate: number | null;
  costUsd: number;
  durationSec: number;
  ok: boolean;
  error?: string;
}

const EVAL_TARGETS: Array<{ name: string; url: string }> = [
  { name: 'saucedemo',     url: 'https://www.saucedemo.com/' },
  { name: 'the-internet',  url: 'https://the-internet.herokuapp.com/' },
  { name: 'practice-todo', url: 'https://demo.playwright.dev/todomvc/' },
];

async function handleEval(ws: WebSocket, usePom: boolean): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(process.cwd(), 'eval-results', ts);
  fs.mkdirSync(runDir, { recursive: true });

  send(ws, {
    text:
      `Starting eval against ${EVAL_TARGETS.length} public sites. ` +
      `Mode: ${usePom ? 'POM (default)' : 'inline (legacy)'}. ` +
      `Estimated cost: ~$0.75. Estimated duration: 5 to 7 minutes.`,
  });

  const results: EvalRow[] = [];

  for (let i = 0; i < EVAL_TARGETS.length; i++) {
    const target = EVAL_TARGETS[i]!;
    const startedAt = Date.now();
    const siteOutDir = path.join(runDir, target.name);

    send(ws, { text: `**[${i + 1}/${EVAL_TARGETS.length}] ${target.name}**\nExploring \`${target.url}\`...` });

    try {
      const result = await explore({
        url: target.url,
        language: 'ts',
        outDir: siteOutDir,
        onEvent: (e) => {
          if (e.type === 'plan_done') {
            send(ws, { text: `  ${e.scenarios.length} scenarios planned · $${e.usd.toFixed(4)}` });
          } else if (e.type === 'critic_done') {
            send(ws, { text: `  ${e.verdicts.length} verdicts · $${e.usd.toFixed(4)}` });
          }
        },
      });

      if (result.paused) {
        results.push(emptyRow(target, 0, 'Run unexpectedly paused.'));
        continue;
      }

      let specPath: string;
      if (usePom) {
        const t = transcribePOM({ report: result, outDir: siteOutDir, name: target.name });
        specPath = t.specFile;
      } else {
        const t = transcribe({ report: result, outDir: siteOutDir, name: target.name });
        specPath = t.specPath;
      }

      const pw = runPlaywrightInline(specPath, target.url);
      const totalCost = result.cost.usd + (result.cost.plannerUsd ?? 0) + (result.cost.criticUsd ?? 0);
      const durationSec = Math.round((Date.now() - startedAt) / 1000);
      const passRate = pw.total > 0 ? Math.round((pw.passed / pw.total) * 100) : null;

      const row: EvalRow = {
        site: target.name, url: target.url,
        scenarios: result.scenarios.length,
        tests: pw.total, passed: pw.passed, failed: pw.failed, flaky: pw.flaky,
        passRate, costUsd: totalCost, durationSec, ok: true,
      };
      results.push(row);

      send(ws, {
        text:
          `  ${pw.passed}/${pw.total} passed (${passRate ?? 0}%) · ` +
          `$${totalCost.toFixed(4)} · ${durationSec}s`,
      });
    } catch (err) {
      const msg = (err as Error).message;
      results.push(emptyRow(target, Math.round((Date.now() - startedAt) / 1000), msg));
      send(ws, { text: `  ✗ ${msg}` });
    }
  }

  // Aggregate + write outputs.
  const totalTests  = results.reduce((s, r) => s + r.tests, 0);
  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalCost   = results.reduce((s, r) => s + r.costUsd, 0);
  const aggregate   = totalTests > 0 ? Math.round((totalPassed / totalTests) * 100) : 0;

  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(results, null, 2));
  const summaryMd = buildEvalSummary(results, totalTests, totalPassed, aggregate, totalCost, usePom);
  fs.writeFileSync(path.join(runDir, 'summary.md'), summaryMd);

  // Final report to chat.
  send(ws, {
    text:
      `**Aggregate.** ${totalPassed}/${totalTests} tests passed (${aggregate}%) at $${totalCost.toFixed(4)} total cost.\n\n` +
      buildEvalTable(results) +
      `\n\nWritten to \`${path.relative(process.cwd(), path.join(runDir, 'summary.md'))}\`.`,
  });

  // Push fresh runs so the dashboard reflects the new eval immediately.
  try {
    const runs = listRunsFromDisk(ROOT);
    send(ws, { type: 'runs', runs } as object);
  } catch { /* best-effort */ }
}

function emptyRow(target: { name: string; url: string }, durationSec: number, error?: string): EvalRow {
  return {
    site: target.name, url: target.url, scenarios: 0, tests: 0,
    passed: 0, failed: 0, flaky: 0, passRate: null,
    costUsd: 0, durationSec, ok: false, error,
  };
}

function buildEvalTable(rows: EvalRow[]): string {
  const lines = [
    '| Site | Scenarios | Tests | Passed | Failed | Pass-rate | Cost (USD) | Time |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const r of rows) {
    const rate = r.passRate == null ? 'no data' : r.passRate + '%';
    lines.push(`| ${r.site} | ${r.scenarios} | ${r.tests} | ${r.passed} | ${r.failed} | ${rate} | ${r.costUsd.toFixed(4)} | ${r.durationSec}s |`);
  }
  return lines.join('\n');
}

function buildEvalSummary(
  rows: EvalRow[],
  totalTests: number,
  totalPassed: number,
  aggregate: number,
  totalCost: number,
  usePom: boolean,
): string {
  return [
    '# QA-Core eval results',
    '',
    `Generated: ${new Date().toISOString().slice(0, 10)}`,
    `Mode: **${usePom ? 'POM (default)' : 'inline (legacy)'}**`,
    '',
    'First-run, unfiltered. The agent generated each spec from scratch (Planner + Explorer + Critic), then Playwright executed it.',
    '',
    buildEvalTable(rows),
    '',
    `**Aggregate.** ${totalPassed}/${totalTests} tests passed (${aggregate}%) at $${totalCost.toFixed(4)} total cost.`,
    '',
  ].join('\n');
}

function runPlaywrightInline(specPath: string, baseUrl: string): { total: number; passed: number; failed: number; flaky: number } {
  const out = path.dirname(specPath);
  const reportPath = path.join(out, 'pw-results.json');
  try {
    execSync(
      `npx playwright test "${specPath}" --reporter=json --project=chromium`,
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          QA_CORE_BASE_URL: baseUrl,
          PLAYWRIGHT_TEST_DIR: out,
          PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    // Playwright exits non-zero on test failures. Expected; we read the report.
  }
  if (!fs.existsSync(reportPath)) return { total: 0, passed: 0, failed: 0, flaky: 0 };
  try {
    const data = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as { stats?: Record<string, number> };
    const stats = data.stats ?? {};
    const expected = stats.expected ?? 0;
    const unexpected = stats.unexpected ?? 0;
    const flaky = stats.flaky ?? 0;
    return {
      total: expected + unexpected + flaky,
      passed: expected,
      failed: unexpected,
      flaky,
    };
  } catch {
    return { total: 0, passed: 0, failed: 0, flaky: 0 };
  }
}

/* ─────────────────── helpers ─────────────────── */

function shutdown(): void {
  console.log('\nShutting down…');
  for (const client of wss.clients) client.close(1001, 'gateway shutting down');
  try { db.close(); } catch { /* already closed */ }
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
