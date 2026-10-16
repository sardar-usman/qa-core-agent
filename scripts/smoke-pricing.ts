/**
 * smoke-pricing: every dollar is priced by the model that spent it
 * (invariant 74). $0, no model call: every stage runs against a fixture
 * client that returns known usage.
 *
 *   A. The price table: 1M of each of the four token kinds prices to the sum
 *      of the four table numbers, exactly, for every model; Opus 5.5 reads
 *      cache at 0.20 per million, not 0.40.
 *   B. An unknown id throws and names every known id; nothing falls back.
 *   C. Each stage records exactly costOf(model, usage), cache tokens
 *      included: Explorer and repair (runAgentLoop), Critic, Planner, page
 *      filter, feature parser, requirements map, Stabilizer, /generate.
 *   D. A non-default Critic and Planner model is priced at that model.
 *   E. The startup refusal: QA_CORE_CRITIC_MODEL=claude-made-up-1 stops the
 *      CLI (a child process), the gateway and the MCP path before any API
 *      call, with one line naming the stage, the id and the known ids.
 *   F. The report records the model per stage (cost.models).
 *
 *   npx tsx scripts/smoke-pricing.ts
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import { z } from 'zod';
import { costOf, priceOf, KNOWN_MODEL_IDS, MODEL_PRICES, UnknownModelError } from '../src/agent/pricing.js';
import { exploreStageModels, unknownModelRefusal, STAGE_MODELS } from '../src/agent/stage-models.js';
import { runAgentLoop, explore, type ReviewPaused } from '../src/agent/runtime.js';
import { createContext } from '../src/agent/tools.js';
import { critique } from '../src/agent/critic.js';
import { plan, snapshotPage } from '../src/agent/planner.js';
import { filterPages } from '../src/agent/page-filter.js';
import { parseNaturalLanguage } from '../src/agent/parse-features.js';
import { buildRequirementsMap } from '../src/agent/requirements.js';
import { proposeStabilityFix } from '../src/agent/stabilizer.js';
import { generateFromStory } from '../src/agent/generate.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { runExploreRequest } from '../src/server/run-explore.js';
import { parseGatewayCommand } from '../src/server/commands.js';
import { exploreArgs, exploreRequestFromToolArgs } from '../src/mcp/tools.js';
import type { RunReport, Scenario } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

// No model env leaks in from the shell: every stage starts at its default.
const MODEL_ENV = ['QA_CORE_PLANNER_MODEL', 'QA_CORE_MODEL_PLANNER', 'QA_CORE_EXPLORER_MODEL', 'QA_CORE_MODEL_EXPLORE', 'QA_CORE_CRITIC_MODEL', 'QA_CORE_MODEL_CRITIC', 'QA_CORE_MODEL_STABILIZER', 'QA_CORE_MODEL_TRANSCRIBE'];
for (const k of MODEL_ENV) delete process.env[k];
for (const k of Object.keys(process.env)) if (k.startsWith('QA_CORE_TEST_')) delete process.env[k];

/* ─── A. the table ──────────────────────────────────────────────────────── */
const M = 1_000_000;
const million = { input_tokens: M, output_tokens: M, cache_creation_input_tokens: M, cache_read_input_tokens: M };
// The four numbers from the pricing page, written out and summed by hand.
const EXPECTED_SUMS: Record<string, number> = {
  'claude-opus-5-5': 29.2, // 4 + 20 + 5 + 0.20
  'claude-opus-4-7': 36.75, // 5 + 25 + 6.25 + 0.50
  'claude-sonnet-5-5': 14.6, // 2 + 10 + 2.50 + 0.10
  'claude-sonnet-4-6': 22.05, // 3 + 15 + 3.75 + 0.30
  'claude-haiku-4-5': 7.35, // 1 + 5 + 1.25 + 0.10
};
check('A0. the table holds exactly the five priced models', JSON.stringify([...KNOWN_MODEL_IDS].sort()) === JSON.stringify(Object.keys(EXPECTED_SUMS).sort()), KNOWN_MODEL_IDS.join(', '));
for (const [model, sum] of Object.entries(EXPECTED_SUMS)) {
  const got = costOf(model, million);
  console.log(`  A lock: ${model}: 1M input + 1M output + 1M cache write + 1M cache read = $${got}`);
  check(`A1. ${model}: four million-token fields price to the sum of the four table numbers ($${sum})`, got === sum, String(got));
}
const opus55Read = costOf('claude-opus-5-5', { cache_read_input_tokens: M });
check('A2. Opus 5.5 cache read is $0.20 per million, not $0.40 (the 0.1x mistake)', opus55Read === 0.2 && MODEL_PRICES['claude-opus-5-5']!.cacheRead === 0.2, String(opus55Read));
check('A3. a missing usage field counts 0', costOf('claude-haiku-4-5', { input_tokens: M }) === 1 && costOf('claude-haiku-4-5', {}) === 0);

/* ─── B. an unknown id ──────────────────────────────────────────────────── */
let unknownErr: unknown = null;
try { costOf('claude-made-up-1', million); } catch (e) { unknownErr = e; }
const unknownMsg = unknownErr instanceof Error ? unknownErr.message : '';
console.log(`  B lock: costOf("claude-made-up-1") -> ${unknownMsg || '(no error)'}`);
check('B1. an unknown id throws an UnknownModelError naming the id and every known id', unknownErr instanceof UnknownModelError && unknownMsg.includes('"claude-made-up-1"') && KNOWN_MODEL_IDS.every((id) => unknownMsg.includes(id)), unknownMsg);
let haiku55: unknown = null;
try { priceOf('claude-haiku-5-5'); } catch (e) { haiku55 = e; }
check('B2. Haiku 5.5 (priced by prompt size) is not in the table and throws like any unknown id', haiku55 instanceof UnknownModelError);

/* ─── C and D. every stage records exactly costOf(model, usage) ─────────── */
const USAGE = { input_tokens: 12_345, output_tokens: 678, cache_creation_input_tokens: 9_010, cache_read_input_tokens: 43_210 };
type Usage = typeof USAGE;
const message = (text: string, usage: Usage = USAGE): Anthropic.Message => ({
  id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text, citations: null }],
  stop_reason: 'end_turn', stop_sequence: null, usage,
} as unknown as Anthropic.Message);
/** A fixture client: every call returns `text` with USAGE; it records the model of every call. */
function fixtureClient(text: string): { client: { messages: { create: (p: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message> } }; models: string[] } {
  const models: string[] = [];
  return { client: { messages: { create: async (p) => { models.push(p.model); return message(text); } } }, models };
}
const stageLine = (stage: string, model: string, got: number): void => console.log(`  C lock: ${stage} on ${model}: recorded $${got.toFixed(8)}, costOf $${costOf(model, USAGE).toFixed(8)}`);

const browser = await chromium.launch({ headless: true });
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-pricing-'));
const agentCwd = process.cwd();
try {
  const bctx = await browser.newContext();
  await installEvalShim(bctx);
  const page = await bctx.newPage();
  await page.setContent('<!doctype html><html><head><title>Shop</title></head><body><main><h1>Shop</h1><label for="q">Search</label><input id="q"><button>Go</button></main></body></html>', { waitUntil: 'load' });

  // Explorer and repair: the same loop, priced by the model it was given.
  for (const [label, model, calls, budget] of [['Explorer', 'claude-opus-4-7', 1, 'run'], ['repair pass', 'claude-opus-5-5', 2, 'repair']] as const) {
    let n = 0;
    const client = { messages: { create: async () => { n++; return n < calls ? { ...message(''), content: [{ type: 'tool_use', id: `t${n}`, name: 'get_dom', input: {} }], stop_reason: 'tool_use' } : message('done'); } } } as unknown as Anthropic;
    const loop = await runAgentLoop({ client, model, maxUsd: 5, maxSteps: 40, ctx: createContext(page, 40), url: 'about:blank', plan: [], budget });
    const summed = { input_tokens: USAGE.input_tokens * calls, output_tokens: USAGE.output_tokens * calls, cache_creation_input_tokens: USAGE.cache_creation_input_tokens * calls, cache_read_input_tokens: USAGE.cache_read_input_tokens * calls };
    console.log(`  C lock: ${label} on ${model}, ${calls} call(s): recorded $${loop.cost.usd.toFixed(8)}, costOf $${costOf(model, summed).toFixed(8)}`);
    check(`C1. ${label}: ${calls} call(s) on ${model} record exactly costOf(model, summed usage), cache tokens included`, n === calls && loop.cost.usd === costOf(model, summed), `${n} calls, ${loop.cost.usd}`);
  }

  // Critic: default model, then a non-default one.
  const scenario: Scenario = { name: 'shows the shop heading', category: 'happy', steps: [{ kind: 'navigate', url: 'https://s.example/' }, { kind: 'assert', name: 'h', assertion: { type: 'toBeVisible', target: { level: 'role', arg: { role: 'heading', name: 'Shop' }, intent: 'heading' }, timeout: 10000 } }] };
  const verdictText = `[{"scenario":"shows the shop heading","verdict":"pass","reasons":["sound"],"required_fixes":[]}]\n<summary>fine</summary>`;
  for (const model of [undefined, 'claude-opus-5-5'] as const) {
    const f = fixtureClient(verdictText);
    const r = await critique({ scenarios: [scenario], url: 'https://s.example/', client: f.client, ...(model ? { model } : {}) });
    const used = model ?? STAGE_MODELS.critic.defaultModel;
    stageLine(`Critic${model ? ' (non-default)' : ''}`, used, r.costUsd);
    check(`${model ? 'D1' : 'C2'}. Critic on ${used}: called that model once and recorded exactly costOf(${used}, usage)`, f.models.length === 1 && f.models[0] === used && r.costUsd === costOf(used, USAGE), JSON.stringify({ models: f.models, cost: r.costUsd }));
  }
  check('D2. the non-default Critic price differs from the default\'s (Opus 5.5 is not priced as Sonnet 4.6)', costOf('claude-opus-5-5', USAGE) !== costOf('claude-sonnet-4-6', USAGE));

  // Planner: default model, then a non-default one, on a real snapshot.
  const snapshot = await snapshotPage(page);
  for (const model of [undefined, 'claude-opus-5-5'] as const) {
    const f = fixtureClient('1. [search][happy] searched for a product and saw the results heading — fails if search breaks');
    const r = await plan({ url: 'https://s.example/', snapshot, client: f.client as never, apiKey: 'fixture', ...(model ? { model } : {}) });
    const used = model ?? STAGE_MODELS.planner.defaultModel;
    stageLine(`Planner${model ? ' (non-default)' : ''}`, used, r.costUsd);
    check(`${model ? 'D3' : 'C3'}. Planner on ${used}: called that model once and recorded exactly costOf(${used}, usage)`, f.models.length === 1 && f.models[0] === used && r.costUsd === costOf(used, USAGE), JSON.stringify({ models: f.models, cost: r.costUsd }));
  }

  // Page filter: more candidates than the cap, so the model picks.
  {
    const pages = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'].map((p) => ({ url: `https://s.example/${p}/one`, source: 'crawl' as const }));
    const f = fixtureClient(JSON.stringify([{ url: 'https://s.example/alpha/one', feature: 'shop' }]));
    const r = await filterPages({ pages, apiKey: 'fixture', client: f.client });
    stageLine('page filter', STAGE_MODELS.pageFilter.defaultModel, r.costUsd);
    check('C4. page filter: called claude-haiku-4-5 once and recorded exactly costOf', r.method === 'llm' && f.models.length === 1 && f.models[0] === 'claude-haiku-4-5' && r.costUsd === costOf('claude-haiku-4-5', USAGE), JSON.stringify({ method: r.method, models: f.models, cost: r.costUsd }));
  }
  // Feature parser, including the reply that does not parse (it is still paid).
  {
    const f = fixtureClient('["login","cart"]');
    const r = await parseNaturalLanguage('test login and cart', 'fixture', undefined, f.client);
    stageLine('feature parser', 'claude-haiku-4-5', r.costUsd);
    check('C5. feature parser: recorded exactly costOf(claude-haiku-4-5, usage)', f.models[0] === 'claude-haiku-4-5' && r.costUsd === costOf('claude-haiku-4-5', USAGE) && r.features.join(',') === 'login,cart', JSON.stringify(r));
    const bad = await parseNaturalLanguage('test login', 'fixture', undefined, fixtureClient('not json at all').client);
    check('C5b. an unparseable feature-parser reply still records what the call cost (it used to report $0)', bad.features.length === 0 && bad.costUsd === costOf('claude-haiku-4-5', USAGE), JSON.stringify(bad));
  }
  // Requirements map.
  {
    const f = fixtureClient(JSON.stringify({ features: [{ name: 'shop', description: 'the shop', rules: [{ id: 'R1', text: 'The shop shows its heading.', type: 'behavior' }] }], roles: [] }));
    const r = await buildRequirementsMap({ srsText: 'The shop shows its heading.', apiKey: 'fixture', client: f.client });
    stageLine('requirements map', 'claude-haiku-4-5', r.costUsd);
    check('C6. requirements map: called claude-haiku-4-5 once and recorded exactly costOf', f.models.length === 1 && f.models[0] === 'claude-haiku-4-5' && r.costUsd === costOf('claude-haiku-4-5', USAGE) && r.map.features.length === 1, JSON.stringify({ models: f.models, cost: r.costUsd }));
  }
  // Stabilizer: cache tokens included (the old estimate counted none and priced any Opus at 15/75).
  for (const model of [undefined, 'claude-opus-4-7'] as const) {
    const f = fixtureClient('<kind>timeout_raise</kind>\n<timeout>15000</timeout>\n<reason>slow banner</reason>');
    const r = await proposeStabilityFix({ scenario, failure: { failedStep: 1, stepKind: 'assert', error: 'toBeVisible timed out', pattern: 'P-F-P' }, client: f.client as unknown as Anthropic, ...(model ? { model } : {}) });
    const used = model ?? STAGE_MODELS.stabilizer.defaultModel;
    stageLine(`Stabilizer${model ? ' (Opus 4.7)' : ''}`, used, r.costUsd);
    const oldEstimate = model ? (USAGE.input_tokens * 15 + USAGE.output_tokens * 75) / M : (USAGE.input_tokens * 3 + USAGE.output_tokens * 15) / M;
    check(`C7. Stabilizer on ${used}: recorded exactly costOf(${used}, usage), cache read and write included (the old estimate gave $${oldEstimate.toFixed(8)})`, f.models[0] === used && r.costUsd === costOf(used, USAGE) && r.costUsd !== oldEstimate && r.proposal.kind === 'timeout_raise', JSON.stringify({ models: f.models, cost: r.costUsd }));
  }
  // /generate.
  {
    const f = fixtureClient('<feature>search</feature><scenarios>1</scenarios><spec>import { test } from "@playwright/test";</spec>');
    const r = await generateFromStory({ story: 'As a shopper I search', language: 'ts', client: f.client });
    stageLine('/generate', 'claude-sonnet-4-6', r.costUsd);
    check('C8. /generate: records the model it called and exactly costOf(model, usage)', r.model === 'claude-sonnet-4-6' && f.models[0] === 'claude-sonnet-4-6' && r.costUsd === costOf('claude-sonnet-4-6', USAGE), JSON.stringify({ model: r.model, cost: r.costUsd }));
    let genErr: unknown = null;
    const g = fixtureClient('x');
    try { await generateFromStory({ story: 's', language: 'ts', model: 'claude-made-up-1', client: g.client }); } catch (e) { genErr = e; }
    check('C9. /generate on an unknown model throws before the call (zero calls)', genErr instanceof UnknownModelError && g.models.length === 0);
  }

  /* ─── F. cost.models on the report ────────────────────────────────────── */
  {
    process.chdir(tmpRoot);
    const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><head><title>Shop</title></head><body><main><h1>Shop</h1></main></body></html>'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const siteUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    process.env.ANTHROPIC_API_KEY ??= 'fixture-key-never-sent';
    process.env.QA_CORE_CRITIC_MODEL = 'claude-opus-5-5';
    try {
      const client = { messages: { create: async () => message('done') } } as unknown as Anthropic;
      const r = await explore({ url: siteUrl, language: 'ts', outDir: path.join(tmpRoot, 'models-run'), fromPlan: [{ name: 'shows the shop heading', category: 'happy', rationale: 'r' }], model: 'claude-sonnet-5-5', maxUsd: 2, skipCritic: true, skipReplay: true, skipStability: true, stabilize: false, loginPreflightDone: true, explorerClient: client });
      const models = (r as RunReport).cost.models;
      console.log(`  F lock: cost.models = ${JSON.stringify(models)}`);
      check('F1. the report records the model per stage, the override and the env included', !(r as ReviewPaused).paused && models?.explorer === 'claude-sonnet-5-5' && models.critic === 'claude-opus-5-5' && models.planner === 'claude-haiku-4-5' && models.stabilizer === 'claude-sonnet-4-6' && models.requirements === 'claude-haiku-4-5' && models.pageFilter === 'claude-haiku-4-5', JSON.stringify(models));
      check('F2. the Explorer cost on that report is priced by the overriding model', (r as RunReport).cost.usd === costOf('claude-sonnet-5-5', USAGE), String((r as RunReport).cost.usd));
    } finally {
      delete process.env.QA_CORE_CRITIC_MODEL;
      server.close();
      process.chdir(agentCwd);
    }
  }
} finally {
  await browser.close();
}

/* ─── E. the startup refusal on every surface ───────────────────────────── */
{
  // One local server stands in for the site AND the Anthropic API: any
  // request to it is a call the refusal should have prevented.
  let hits = 0;
  const server = http.createServer((_q, res) => { hits++; res.writeHead(500); res.end('{}'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const expectedLine = `Run refused: the critic model "claude-made-up-1" is not in the price table; known ids: ${KNOWN_MODEL_IDS.join(', ')}. Nothing was spent.`;
  check('E0. unknownModelRefusal names the stage, the id and the known ids', unknownModelRefusal({ QA_CORE_CRITIC_MODEL: 'claude-made-up-1' }) === expectedLine && unknownModelRefusal({}) === null && unknownModelRefusal({ QA_CORE_MODEL_CRITIC: 'claude-made-up-1' }) === expectedLine);
  check('E0b. every stage default is priced', unknownModelRefusal({}) === null && Object.values(exploreStageModels({})).every((m) => KNOWN_MODEL_IDS.includes(m)));

  // CLI: a child process, cwd a temp dir, the API base URL at the counting server.
  const cliCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-pricing-cli-'));
  const env: NodeJS.ProcessEnv = { ...process.env, QA_CORE_CRITIC_MODEL: 'claude-made-up-1', ANTHROPIC_API_KEY: 'fixture-key-never-sent', ANTHROPIC_BASE_URL: base };
  const cli = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(path.join(agentCwd, 'node_modules/.bin/tsx'), [path.join(agentCwd, 'src/cli/explore.ts'), `${base}/`], { cwd: cliCwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const cliLines = (cli.stdout + cli.stderr).trim().split('\n').filter(Boolean);
  console.log(`  E lock (CLI): exit ${String(cli.code)}; ${cliLines.join(' | ')}`);
  check('E1. CLI: exit code 1, one line naming the stage, the id and the known ids, zero requests, no output folder',
    cli.code === 1 && cliLines.length === 1 && cliLines[0] === expectedLine && hits === 0 && !fs.existsSync(path.join(cliCwd, 'output')), JSON.stringify({ code: cli.code, cliLines, hits, output: fs.existsSync(path.join(cliCwd, 'output')) }));
  fs.rmSync(cliCwd, { recursive: true, force: true });

  // Gateway and MCP: runExploreRequest with seams that count every call.
  const prevBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = base;
  const surfaces: Array<{ label: string; request: () => ReturnType<typeof exploreRequestFromToolArgs>; source: 'dashboard' | 'mcp'; viaEnv: boolean }> = [
    { label: 'gateway, QA_CORE_CRITIC_MODEL in the env', source: 'dashboard', viaEnv: true, request: () => { const c = parseGatewayCommand(`/explore ${base}/`, { lang: 'ts' }); if (c.kind !== 'explore') throw new Error(c.kind); return c.request; } },
    { label: 'gateway, --critic-model on the command', source: 'dashboard', viaEnv: false, request: () => { const c = parseGatewayCommand(`/explore ${base}/ --critic-model claude-made-up-1`, { lang: 'ts' }); if (c.kind !== 'explore') throw new Error(c.kind); return c.request; } },
    { label: 'MCP, QA_CORE_CRITIC_MODEL in the env', source: 'mcp', viaEnv: true, request: () => exploreRequestFromToolArgs(z.object(exploreArgs).parse({ url: `${base}/` })) },
    { label: 'MCP, criticModel argument', source: 'mcp', viaEnv: false, request: () => exploreRequestFromToolArgs(z.object(exploreArgs).parse({ url: `${base}/`, criticModel: 'claude-made-up-1' })) },
  ];
  for (const s of surfaces) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-pricing-surface-'));
    let exploreCalls = 0;
    let preflightCalls = 0;
    if (s.viaEnv) process.env.QA_CORE_CRITIC_MODEL = 'claude-made-up-1';
    let error = '';
    try {
      await runExploreRequest({
        request: s.request(), projectRoot: root, source: s.source,
        exploreImpl: (async () => { exploreCalls++; throw new Error('explore must not run'); }) as never,
        preflight: (async () => { preflightCalls++; throw new Error('preflight must not run'); }) as never,
      });
    } catch (e) { error = (e as Error).message; }
    if (s.viaEnv) delete process.env.QA_CORE_CRITIC_MODEL;
    console.log(`  E lock (${s.label}): ${error || '(no error)'}`);
    check(`E2. ${s.label}: refused with the same line, zero explore, preflight and API calls, no output folder`, error === expectedLine && exploreCalls === 0 && preflightCalls === 0 && hits === 0 && !fs.existsSync(path.join(root, 'output')), JSON.stringify({ error, exploreCalls, preflightCalls, hits }));
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevBase;
  check('E3. the gateway and MCP left the critic env as they found it', process.env.QA_CORE_CRITIC_MODEL === undefined);
  server.close();
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: one price table keyed by model id; every stage records costOf(the model it called, all four usage fields); an unknown id throws and refuses the run before any call on the CLI, the gateway and MCP; the report records each stage\'s model.');
