import 'dotenv/config';
import { execSync } from 'node:child_process';
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
import { runExploreRequest, runTranscribeRequest, type FrameworkZip } from './run-explore.js';
import { eventForUi } from './events.js';

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
 *   {type:'run_started', ...}    the resolved request for the run header
 *   {type:'event', event}        every AgentEvent, for the live pipeline view
 *   {type:'run_report', report}  the final RunReport (traces stripped); also the
 *                                reply to a get_report request (fromHistory: true)
 *   {type:'framework_zip', ...}  the zipped framework, base64
 *   {type:'runs', runs}          run history from disk
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
  /** 'message' for slash commands; 'list_runs' / 'get_settings' / 'get_report' for state sync. */
  type?: string;
  content?: string;
  agent?: string;
  model?: string;
  lang?: 'ts' | 'js';
  /** Per-run setting overrides from the dashboard, keyed by env name. */
  env?: Record<string, string>;
  /** An SRS document uploaded from the dashboard (md/txt/pdf/docx). */
  srs?: { name: string; base64: string };
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

const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on('error', (err: NodeJS.ErrnoException) => {
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

  ws.on('message', async (raw) => {
    let msg: IncomingMessage;
    try { msg = JSON.parse(raw.toString()) as IncomingMessage; } catch { return; }

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
      try { send(ws, { type: 'runs', runs: listRunsFromDisk(ROOT) }); } catch { /* best-effort */ }
    } catch (err) {
      send(ws, { text: `✗ ${(err as Error).message}` });
      send(ws, { type: 'run_failed', error: (err as Error).message });
    } finally {
      state.busy = false;
    }
  });
});

console.log(`QA-Core gateway listening on ws://${HOST}:${PORT}`);
console.log(TOKEN ? '  (token required via ?token=…)' : '  (no token, local use only)');
console.log('');
console.log('Open qa-core-ui.html in your browser, click Connect.');

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
      if (msg.srs && !request.srs && !request.resume) {
        request.srs = saveUpload(msg.srs);
        send(ws, { text: `Note: using the uploaded SRS ${path.basename(request.srs)}.` });
      }
      if (cmd.naturalHint) {
        const parsed = await parseFeatures({ naturalInput: cmd.naturalHint });
        request.features = parsed.features;
      }
      await handleExplore(request, msg.model, ws);
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

/** Write an uploaded SRS under output/.uploads and return its relative path. */
function saveUpload(upload: { name: string; base64: string }): string {
  const safe = path.basename(upload.name).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'srs.txt';
  const ext = path.extname(safe).toLowerCase();
  if (!['.md', '.txt', '.pdf', '.docx'].includes(ext)) {
    throw new Error(`Unsupported SRS type "${ext || 'none'}". Upload .md, .txt, .pdf, or .docx.`);
  }
  const dir = path.join(ROOT, 'output', '.uploads');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId()}-${safe}`);
  fs.writeFileSync(file, Buffer.from(upload.base64, 'base64'));
  return path.relative(ROOT, file);
}

/* ─────────────────── /explore + /resume ─────────────────── */

async function handleExplore(request: ExploreRequest, model: string | undefined, ws: WebSocket): Promise<void> {
  if (activeExplores > 0) {
    send(ws, { text: '⏳ Another explore run is active on this gateway. Wait for it to finish (per-run settings apply to one run at a time).' });
    return;
  }
  activeExplores++;
  try {
    send(ws, {
      type: 'run_started',
      command: request.resume ? 'resume' : 'explore',
      request: {
        url: request.url ?? null, lang: request.lang, pom: request.pom, features: request.features,
        srs: request.srs ?? null, discover: request.discover, urls: request.urls, resume: request.resume ?? null,
        stabilize: request.stabilize, stabilizeAttempts: request.stabilizeAttempts, env: request.env,
      },
      settings: readRunSettings({ ...process.env, ...request.env }),
    });
    const outcome = await runExploreRequest({
      request, projectRoot: ROOT,
      ...(model ? { model } : {}),
      onNote: (text) => send(ws, { text }),
      onEvent: (e) => {
        send(ws, { type: 'event', event: eventForUi(e) });
        if (e.type === 'message' && e.text.trim().length > 0 && e.text.length < 600 && !e.text.startsWith('Run stopped:')) {
          send(ws, { text: e.text.trim() });
        }
      },
    });

    send(ws, {
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
  } finally {
    activeExplores--;
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
  const outcome = runTranscribeRequest({ reportPath, ...(outDir ? { outDir } : {}) }, ROOT);
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
  wss.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
