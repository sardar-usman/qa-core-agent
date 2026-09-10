#!/usr/bin/env node
/**
 * QA-Core MCP server.
 *
 * Exposes QA-Core's workflows as MCP tools so any MCP-aware client (Claude
 * Desktop, Cursor, Cline, Continue, Zed) can invoke them directly without
 * the gateway or the web UI:
 *
 *   qa_explore     drive a real browser, emit a Playwright framework (zip)
 *   qa_resume      continue a stopped run from its checkpoint.json
 *   qa_transcribe  regenerate a framework from an existing run-report.json
 *   qa_generate    single-shot user-story to spec
 *   qa_heal        re-resolve broken selectors on a live page
 *
 * Plus resources for the per-host memory and recent runs.
 *
 * Tool argument schemas live in tools.ts (pure) and every explore argument
 * maps onto the same ExploreRequest the CLI and the gateway build, so a tool
 * call and a CLI invocation with the same ask run the same options.
 *
 * Important to know:
 *  - Communicates over stdio. All log output goes to stderr, never stdout,
 *    or the protocol breaks.
 *  - Tool calls can take 30-120s (longer for multi-page runs).
 *  - ANTHROPIC_API_KEY must be set in the host's MCP config (the env block).
 *    We fail clean inside the tool call instead of crashing on launch.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { generateFromStory } from '../agent/generate.js';
import { heal } from '../cli/heal.js';
import { runExploreRequest, runTranscribeRequest, type RunExploreOutcome } from '../server/run-explore.js';
import {
  exploreArgs, resumeArgs, transcribeArgs, generateArgs, healArgs,
  exploreRequestFromToolArgs, resumeRequestFromToolArgs,
} from './tools.js';
import type { ExploreRequest } from '../agent/explore-request.js';

/**
 * Where output gets written. Hosts run the MCP server from arbitrary cwds, so
 * the user sets QA_CORE_PROJECT_ROOT in their MCP config to point at the
 * project dir they want runs to land in. Falls back to cwd.
 */
const PROJECT_ROOT = process.env.QA_CORE_PROJECT_ROOT ?? process.cwd();

function log(...parts: unknown[]): void {
  // CRITICAL: stderr only. stdout is reserved for the MCP wire protocol.
  process.stderr.write('[qa-core/mcp] ' + parts.map(String).join(' ') + '\n');
}

function requireApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set in the MCP server env. Add it to your client config (e.g. claude_desktop_config.json → mcpServers.qa-core.env.ANTHROPIC_API_KEY).',
    );
  }
  return key;
}

function runId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function slug(s: string, max = 40): string {
  return s.replace(/^https?:\/\//, '').replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max).toLowerCase() || 'run';
}

function projectFile(...segs: string[]): string {
  return path.join(PROJECT_ROOT, ...segs);
}

const server = new McpServer(
  { name: 'qa-core', version: '0.4.0' },
  {
    capabilities: { tools: {}, resources: {} },
    instructions: [
      'QA-Core is an autonomous QA agent that generates Playwright test suites.',
      '',
      'Use qa_explore when the user gives you a URL and wants a verified test suite: the agent drives a real browser through the page(s) and emits a Page Object Model framework as a zip. Pass srs for requirements-driven planning, urls or discover for multi-page runs, features to steer scope.',
      'Use qa_resume when a previous run stopped early (cost ceiling, billing, API failure) and left a checkpoint.json; it continues from where it stopped, optionally with a higher ceilingUsd.',
      'Use qa_transcribe to regenerate the framework from an existing run-report.json without exploring again (no browser, no model call).',
      'Use qa_generate when the user gives you a user story or Jira ticket and wants a spec derived from acceptance criteria (faster, but unverified until you run it).',
      'Use qa_heal when the user has an existing spec that broke after a UI change; it re-resolves selectors against the live page.',
      '',
      'Tool calls take 30-120 seconds, longer for multi-page runs. Tell the user so they understand the wait.',
      'Output is written under <project>/output/<brand>-automation-framework/ with the zip alongside. The tool result includes the run summary and the reconciliation funnel.',
    ].join('\n'),
  },
);

/* ─────────────────────── explore + resume ─────────────────────── */

function outcomeText(outcome: RunExploreOutcome): { text: string; isError: boolean } {
  const lines: string[] = [];
  if (outcome.kind === 'empty') {
    lines.push('✗ No framework was written: 0 scenarios survived the pipeline.');
    lines.push(...(outcome.diagnosis ?? []));
    if (outcome.resumeHint) lines.push('', outcome.resumeHint);
    return { text: lines.join('\n'), isError: true };
  }
  const zipLine = outcome.zip
    ? `  Zip:     ${path.join(path.dirname(path.relative(PROJECT_ROOT, outcome.outDir)), outcome.zip.filename)} (${outcome.zip.scenarios} scenarios, ${outcome.zip.fileCount} files)`
    : `  Spec:    ${path.relative(PROJECT_ROOT, outcome.specPath ?? '')}`;
  lines.push(`✓ ${outcome.kind === 'framework' ? 'Framework written' : 'Spec written'} for ${outcome.report.url}`);
  lines.push(`  Report:  ${outcome.reportPath}`);
  lines.push(zipLine);
  lines.push('', ...outcome.summary);
  if (outcome.checkpointPath) lines.push('', `Checkpoint kept at ${outcome.checkpointPath} (run stopped early: ${outcome.report.stopped?.reason ?? 'see report'}).`);
  if (outcome.resumeHint) lines.push(outcome.resumeHint.replace(/npm run explore -- --resume \S+/, `qa_resume with checkpointPath=${outcome.checkpointPath ?? ''}`));
  return { text: lines.join('\n'), isError: false };
}

async function runRequest(request: ExploreRequest): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  requireApiKey();
  const notes: string[] = [];
  const outcome = await runExploreRequest({
    request, projectRoot: PROJECT_ROOT,
    onNote: (n) => { notes.push(n); log(n); },
    onEvent: (e) => {
      if (e.type === 'plan_done') log(`${e.scenarios.length} scenarios planned`);
      else if (e.type === 'critic_done') log(`${e.verdicts.length} verdicts`);
      else if (e.type === 'tool_result' && !e.ok) log(`✗ ${e.error}`);
    },
  });
  const { text, isError } = outcomeText(outcome);
  return { content: [{ type: 'text', text: [...notes, '', text].join('\n') }], ...(isError ? { isError } : {}) };
}

server.tool(
  'qa_explore',
  'Drive a real Chromium browser through a URL and generate a Playwright Page Object Model framework. Pipeline: Planner (Haiku) → Explorer (Opus, tool-use) → Critic (Sonnet, verdicts + one repair pass) → Reality-Check replay → Stability (3x) → framework + zip. Every argument mirrors a CLI flag (named in its description). Takes 30-120s, longer for multi-page runs. Returns the run summary, the reconciliation funnel (planned = generated + dropped + incomplete + findings + skipped), rule coverage on SRS runs, and the paths of the report and zip.',
  exploreArgs,
  async (args) => {
    let srsPathFromText: string | undefined;
    if (!args.srs && args.srsText) {
      const dir = projectFile('output', '.uploads');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${runId()}-srs.md`);
      fs.writeFileSync(file, args.srsText);
      srsPathFromText = path.relative(PROJECT_ROOT, file);
    }
    const request = exploreRequestFromToolArgs(args, srsPathFromText);
    log('explore', request.url ?? '');
    return runRequest(request);
  },
);

server.tool(
  'qa_resume',
  'Continue a run that stopped early (cost ceiling, billing exhaustion, persistent API failure) from the checkpoint.json it left behind. URL, language, features, page set, requirements map, completed traces and critic verdicts are restored; only the remaining scenarios are explored. Pass ceilingUsd to raise the budget for the continuation. Same as the CLI: npm run explore -- --resume <checkpoint.json>.',
  resumeArgs,
  async (args) => {
    const request = resumeRequestFromToolArgs(args);
    log('resume', request.resume ?? '');
    return runRequest(request);
  },
);

server.tool(
  'qa_transcribe',
  'Regenerate the Playwright framework and zip from an existing run-report.json without exploring again. No browser, no model call: the same emission the explore pipeline runs after its last stage. Use it after emitter changes or to recover a deliverable. Same as the CLI: npm run transcribe -- <run-report.json> [--out <dir>].',
  transcribeArgs,
  async (args) => {
    const outcome = runTranscribeRequest({ reportPath: args.reportPath, ...(args.outDir ? { outDir: args.outDir } : {}) }, PROJECT_ROOT);
    const zipPath = path.join(path.dirname(path.relative(PROJECT_ROOT, outcome.outDir)), outcome.zip.filename);
    const lines = [
      ...outcome.notes,
      `✓ ${outcome.zip.scenarios} scenarios, ${outcome.zip.fileCount} files`,
      `  Zip: ${zipPath}`,
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

/* ─────────────────────── qa_generate ─────────────────────── */

server.tool(
  'qa_generate',
  'Convert a user story or acceptance criteria into a Playwright spec via a single LLM call. Faster than qa_explore (no browser), but the spec is marked UNVERIFIED. Run it with `npx playwright test` before trusting it.',
  generateArgs,
  async ({ story, language, baseUrl }) => {
    requireApiKey();
    log('generate', story.slice(0, 40), '…');

    const result = await generateFromStory({ story, language: language ?? 'ts', baseUrl });
    const outDir = projectFile('output', `${runId()}-generate`);
    fs.mkdirSync(outDir, { recursive: true });
    const file = `${slug(result.feature)}.spec.${language ?? 'ts'}`;
    const specPath = path.join(outDir, file);
    const header = '// UNVERIFIED. Generated from a user story without browser execution.\n// Run `npx playwright test` against it before trusting the output.\n\n';
    fs.writeFileSync(specPath, header + result.spec + (result.spec.endsWith('\n') ? '' : '\n'));

    const summary = [
      `✓ ${result.scenarios} scenarios for "${result.feature}"`,
      `  Spec: ${path.relative(PROJECT_ROOT, specPath)}`,
      '  ⚠ UNVERIFIED. Run before trusting.',
      '',
      '--- Generated spec ---',
      fs.readFileSync(specPath, 'utf8'),
    ].join('\n');

    return { content: [{ type: 'text', text: summary }] };
  },
);

/* ─────────────────────── qa_heal ─────────────────────── */

server.tool(
  'qa_heal',
  'Re-resolve broken selectors in an existing Playwright spec. Opens the live page the spec targets, probes every locator, and re-resolves the broken ones with the same locator ladder the Explorer uses (semantic intent → a different stable locator, confirmed to be the same element). Writes the repaired files back and reports anything it could not heal. Deterministic, no model call.',
  healArgs,
  async ({ specPath, baseUrl }) => {
    const fullPath = path.isAbsolute(specPath) ? specPath : projectFile(specPath);
    if (!fs.existsSync(fullPath)) {
      return {
        content: [{ type: 'text', text: `✗ Spec not found: ${specPath}` }],
        isError: true,
      };
    }
    log('heal', fullPath);

    const result = await heal({ specPath: fullPath, baseUrl });

    if (result.healed.length === 0 && result.unhealable.length === 0) {
      return {
        content: [{ type: 'text', text: `Nothing to heal. All ${result.scanned} locator(s) still resolve on the live page.` }],
      };
    }

    const lines = [
      `${result.intact} intact · ${result.healed.length} healed · ${result.unhealable.length} unhealable (of ${result.scanned} scanned)`,
      '',
      ...result.healed.map((h) => `✓ ${path.relative(PROJECT_ROOT, h.file)}\n    was: ${h.old}\n    now: ${h.new}`),
      ...result.unhealable.map((u) => `✗ ${path.relative(PROJECT_ROOT, u.file)}: ${u.selector}\n    ${u.reason}`),
    ];
    if (result.healedPath) {
      lines.push('', '--- Patched spec ---', fs.readFileSync(result.healedPath, 'utf8'));
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

/* ─────────────────────── Resources ─────────────────────── */

server.resource(
  'qa-core-runs',
  'qa-core://runs',
  { description: 'Recent runs under this project: directory, status (completed / stopped with checkpoint), report path' },
  async () => {
    const outDir = projectFile('output');
    const runs = fs.existsSync(outDir)
      ? fs.readdirSync(outDir).filter((d) => !d.startsWith('.') && fs.statSync(path.join(outDir, d)).isDirectory()).sort().reverse().slice(0, 20)
      : [];
    const rows = runs.map((r) => {
      const dir = path.join(outDir, r);
      const hasReport = fs.existsSync(path.join(dir, 'run-report.json'));
      const hasCp = fs.existsSync(path.join(dir, 'checkpoint.json'));
      const status = hasCp ? 'stopped (resume with qa_resume)' : hasReport ? 'completed' : 'no report';
      return `- ${r}: ${status}${hasReport ? ` · output/${r}/run-report.json` : ''}${hasCp ? ` · output/${r}/checkpoint.json` : ''}`;
    });
    const body = rows.length === 0 ? 'No runs yet.' : rows.join('\n');
    return {
      contents: [{ uri: 'qa-core://runs', mimeType: 'text/plain', text: body }],
    };
  },
);

server.resource(
  'qa-core-memory',
  'qa-core://memory',
  { description: 'Per-host memory cache (site fingerprints, observed intents, cascade stats)' },
  async () => {
    const memDir = projectFile('.qa-core', 'sites');
    if (!fs.existsSync(memDir)) {
      return {
        contents: [{ uri: 'qa-core://memory', mimeType: 'text/plain', text: 'No site memory yet. Run qa_explore against a URL first.' }],
      };
    }
    const files = fs.readdirSync(memDir).filter((f) => f.endsWith('.json'));
    const parts = files.map((f) => {
      const data = fs.readFileSync(path.join(memDir, f), 'utf8');
      return `# ${f}\n${data}`;
    });
    return {
      contents: [{ uri: 'qa-core://memory', mimeType: 'application/json', text: parts.join('\n\n---\n\n') }],
    };
  },
);

/* ─────────────────────── Connect ─────────────────────── */

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`QA-Core MCP server v0.4.0 ready (project root: ${PROJECT_ROOT})`);
}

main().catch((err) => {
  log('Fatal:', (err as Error).message);
  process.exit(1);
});
