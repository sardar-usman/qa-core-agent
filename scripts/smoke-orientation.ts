/**
 * smoke-orientation: no orientation load before the first planned scenario
 * (invariant 73; run 591732 finding 8: a navigate and a get_dom of the entry
 * page before scenario 1 cost $0.14 although the plan named every page).
 *
 * Driven through explore() with a fixture Explorer (ExploreOptions.explorer
 * Client, a scripted model client that also records what it was sent), on a
 * local site. $0, no model call.
 *
 *   A. A multi-page plan: the first user message names scenario 1 and its
 *      page and forbids a navigate or get_dom before the first begin_scenario.
 *   B. A fixture that navigates and reads the DOM before begin_scenario:
 *      report.orientationCalls is 2 and the console prints one line.
 *   C. A fixture that begins at once: orientationCalls is 0, no line.
 *   D. A single-page plan: the first message is the original text, byte
 *      for byte.
 *
 *   npx tsx scripts/smoke-orientation.ts
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { explore, firstExplorerMessage, EXPLORER_SYSTEM_PROMPT, type AgentEvent, type ReviewPaused } from '../src/agent/runtime.js';
import type { PlannedScenario } from '../src/agent/planner.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

for (const k of Object.keys(process.env)) if (k.startsWith('QA_CORE_TEST_')) delete process.env[k];
process.env.ANTHROPIC_API_KEY ??= 'fixture-key-never-sent';

const server = http.createServer((req, res) => {
  const page = (req.url ?? '/').startsWith('/contact') ? 'Contact' : 'Shop';
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html lang="en"><head><title>${page}</title></head><body><main><h1>${page}</h1></main></body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
const contactUrl = `${siteUrl}contact`;

const SCENARIO = 'the contact page shows its heading';
const multiPagePlan: PlannedScenario[] = [{ name: SCENARIO, category: 'happy', rationale: 'r', feature: 'contact', pageUrl: contactUrl }];
const singlePagePlan: PlannedScenario[] = [{ name: SCENARIO, category: 'happy', rationale: 'r', feature: 'contact' }];
const ORIGINAL_TEXT = `Explore the following URL and produce a Playwright test plan: ${siteUrl}`;

type Call = { name: string; input: Record<string, unknown> };
function scriptedClient(script: Call[]): { client: Anthropic; firstMessage: () => string | null } {
  let n = 0;
  let first: string | null = null;
  const client = {
    messages: {
      create: async (params: { messages: Array<{ role: string; content: unknown }> }) => {
        // The cache breakpoint placement turns the string into one text block.
        if (n === 0) {
          const c = params.messages[0]?.content;
          first = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('') : null;
        }
        const call = script[n];
        n++;
        const u = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        if (!call) return { usage: u, content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
        return { usage: u, content: [{ type: 'tool_use', id: `tu${n}`, name: call.name, input: call.input }], stop_reason: 'tool_use' };
      },
    },
  } as unknown as Anthropic;
  return { client, firstMessage: () => first };
}

const record: Call[] = [
  { name: 'begin_scenario', input: { name: SCENARIO, category: 'happy', feature: 'contact' } },
  { name: 'navigate', input: { url: contactUrl } },
  { name: 'assert', input: { type: 'toBeVisible', role: 'heading', name: 'Contact', intent: 'contact heading', timeout: 10000 } },
  { name: 'end_scenario', input: {} },
  { name: 'finish', input: { summary: 'done' } },
];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-orientation-'));
const agentCwd = process.cwd();
process.chdir(tmpRoot);

async function runOnce(label: string, plan: PlannedScenario[], script: Call[]): Promise<{ report: RunReport; messages: string[]; firstMessage: string | null }> {
  const events: AgentEvent[] = [];
  const { client, firstMessage } = scriptedClient(script);
  const r = await explore({
    url: siteUrl, language: 'ts', outDir: path.join(tmpRoot, label), fromPlan: plan,
    model: 'claude-opus-4-7', maxUsd: 2, skipCritic: true, skipReplay: true, skipStability: true, stabilize: false, loginPreflightDone: true,
    explorerClient: client,
    onEvent: (e) => events.push(e),
  });
  if ((r as ReviewPaused).paused) throw new Error('unexpected pause');
  const messages = events.filter((e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message').map((e) => e.text);
  return { report: r as RunReport, messages, firstMessage: firstMessage() };
}

try {
  /* ─── A and B: a multi-page plan, a fixture that orients first ─────────── */
  const oriented = await runOnce('oriented', multiPagePlan, [
    { name: 'navigate', input: { url: siteUrl } },
    { name: 'get_dom', input: {} },
    ...record,
  ]);
  console.log(`  multi-page first message: ${oriented.firstMessage}`);
  const orientationLines = oriented.messages.filter((m) => m.startsWith('Orientation:'));
  console.log(`  orienting fixture: orientationCalls ${String(oriented.report.orientationCalls)}; console: ${orientationLines.join(' | ') || '(no orientation line)'}`);
  check('A1. the multi-page first message names scenario 1 and its page',
    !!oriented.firstMessage && oriented.firstMessage.includes(`start at scenario 1, "${SCENARIO}"`) && oriented.firstMessage.includes(`call begin_scenario first, then navigate to its page ${contactUrl}`), String(oriented.firstMessage));
  check('A2. it forbids a navigate or get_dom before the first begin_scenario', !!oriented.firstMessage?.includes('Do not call navigate or get_dom before the first begin_scenario.'), String(oriented.firstMessage));
  check('A3. firstExplorerMessage returns the same text', oriented.firstMessage === firstExplorerMessage(multiPagePlan, siteUrl));
  check('B1. a fixture that navigates and reads the DOM before begin_scenario records orientationCalls 2', oriented.report.orientationCalls === 2, String(oriented.report.orientationCalls));
  check('B2. the console prints exactly one orientation line naming both calls', orientationLines.length === 1 && orientationLines[0] === 'Orientation: 2 tool call(s) before the first begin_scenario (navigate, get_dom)', JSON.stringify(orientationLines));
  check('B3. the scenario still shipped', oriented.report.scenarios.length === 1 && oriented.report.scenarios[0]!.name === SCENARIO, JSON.stringify(oriented.report.scenarios.map((s) => s.name)));
  const volatileFirst = firstExplorerMessage([{ ...multiPagePlan[0]!, volatilePage: true }], siteUrl);
  check('A4. a volatile first page is reached from the entry URL by clicking, never by its URL', volatileFirst.includes(`then navigate to ${siteUrl} and click through`) && !volatileFirst.includes(`navigate to its page ${contactUrl}`), volatileFirst);

  check('A5. the Explorer system prompt says the same: skip the entry load when the plan names each page', EXPLORER_SYSTEM_PROMPT.includes('1. Navigate to the URL. When the plan names a page for each scenario, skip steps 1 and 2: call begin_scenario for scenario 1, then navigate to its page.'));

  /* ─── C: a fixture that begins at once ─────────────────────────────────── */
  const direct = await runOnce('direct', multiPagePlan, record);
  console.log(`  direct fixture: orientationCalls ${String(direct.report.orientationCalls)}; console: ${direct.messages.filter((m) => m.startsWith('Orientation:')).join(' | ') || '(no orientation line)'}`);
  check('C1. a fixture that begins at once records orientationCalls 0 and prints no line', direct.report.orientationCalls === 0 && !direct.messages.some((m) => m.startsWith('Orientation:')), JSON.stringify({ calls: direct.report.orientationCalls }));

  /* ─── D: a single-page plan keeps the original text ────────────────────── */
  const single = await runOnce('single', singlePagePlan, record);
  console.log(`  single-page first message: ${single.firstMessage}`);
  check('D1. a single-page plan\'s first message is unchanged, byte for byte', single.firstMessage === ORIGINAL_TEXT && firstExplorerMessage(singlePagePlan, siteUrl) === ORIGINAL_TEXT, String(single.firstMessage));
} finally {
  process.chdir(agentCwd);
  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: a multi-page plan starts at scenario 1 with no orientation load; orientationCalls is recorded and printed; a single-page plan keeps its first message.');
