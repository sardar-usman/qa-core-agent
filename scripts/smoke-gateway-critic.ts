/**
 * Locks the critic parse through the GATEWAY path (src/server/run-explore.ts)
 * with a fake Anthropic client, and confirms the CLI path is unaffected.
 *
 * Background (the first dashboard-initiated live run): the critic reviewed 3
 * saucedemo login scenarios and the run reported zero verdicts while the
 * summary parsed. The entry point was suspected. The two paths call
 * critique() identically ({scenarios, url, apiKey}); the gateway only adds a
 * per-run env override around the whole run, and its event trimming runs
 * after the response is parsed. The real cause was content: the critic
 * quoted the URL regex it was shown ("/saucedemo\.com//") inside a reason
 * string, JSON.parse rejects the "\." escape, and the whole verdict array was
 * discarded. This smoke:
 *   - runs runExploreRequest with a fake explore that calls the REAL critique
 *     against the saucedemo-shaped response, asserting 3 verdicts parse, the
 *     per-run critic-model override is visible to the critic at call time
 *     and restored afterwards, the report carries the verdicts, and the
 *     outcome is a written spec,
 *   - runs the same fixture on the CLI path (critique with no override) and
 *     asserts byte-identical verdicts and the default model,
 *   - asserts eventForUi forwards critic_done untouched,
 *   - asserts the toHaveURL rendering no longer produces "/pattern//",
 *   - asserts a still-unparseable response keeps the raw text on the report.
 *
 * No browser, no network, no model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { critique, describeStep, type CriticClient } from '../src/agent/critic.js';
import { runExploreRequest } from '../src/server/run-explore.js';
import { eventForUi } from '../src/server/events.js';
import { defaultExploreRequest } from '../src/agent/explore-request.js';
import type { RunReport, Scenario } from '../src/agent/trace.js';
import type { ExploreOptions, AgentEvent } from '../src/agent/runtime.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

/* ─── Fixture: the saucedemo run's scenarios and a response shaped like the critic's ─── */

const target = (intent: string, arg: string) => ({ level: 'text' as const, arg, intent });
const scenarios: Scenario[] = [
  { name: 'logged in with valid credentials', feature: 'login', category: 'happy', steps: [
    { kind: 'navigate', url: 'https://www.saucedemo.com/' },
    { kind: 'fill', target: { level: 'placeholder', arg: 'Username', intent: 'username input' }, value: 'standard_user' },
    { kind: 'fill', target: { level: 'placeholder', arg: 'Password', intent: 'password input' }, value: 'secret_sauce' },
    { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Login' }, intent: 'login button' } },
    { kind: 'assert', name: 'url', assertion: { type: 'toHaveURL', pattern: '/inventory\\.html' } },
  ] },
  { name: 'rejected an invalid password', feature: 'login', category: 'negative', steps: [
    { kind: 'navigate', url: 'https://www.saucedemo.com/' },
    { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Login' }, intent: 'login button' } },
    { kind: 'assert', name: 'error', assertion: { type: 'toContainText', target: target('login error message', 'Username and password do not match'), text: 'Username and password do not match', timeout: 10000 } },
  ] },
  { name: 'rejected a blank username field', feature: 'login', category: 'edge', steps: [
    { kind: 'navigate', url: 'https://www.saucedemo.com/' },
    { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Login' }, intent: 'login button' } },
    { kind: 'assert', name: 'error', assertion: { type: 'toContainText', target: target('login error message', 'Username is required'), text: 'Username is required', timeout: 10000 } },
    { kind: 'assert', name: 'url', assertion: { type: 'toHaveURL', pattern: 'saucedemo\\.com/' } },
  ] },
];

// The critic quotes the regexes it was shown. "\." is not a JSON escape.
const SAUCEDEMO_RESPONSE = `[
  { "scenario": "logged in with valid credentials", "verdict": "pass", "reasons": ["asserts /inventory\\.html after login with a timeout"], "required_fixes": [] },
  { "scenario": "rejected an invalid password", "verdict": "pass", "reasons": ["asserts the visible error text"], "required_fixes": [] },
  { "scenario": "rejected a blank username field", "verdict": "rework", "reasons": ["the URL regex /saucedemo\\.com// has a doubled trailing slash", "redundant with the error assertion"], "required_fixes": ["remove the URL check"], }
]

<summary>
Overall the spec is in good shape: the blank-username edge case is the only weak point.
</summary>`;

function fakeClient(responseText: string, seen: { model?: string; envAtCall?: string | undefined }): CriticClient {
  return {
    messages: {
      create: async (params) => {
        seen.model = params.model;
        seen.envAtCall = process.env.QA_CORE_CRITIC_MODEL;
        return {
          id: 'msg_fake', type: 'message', role: 'assistant', model: params.model,
          content: [{ type: 'text', text: responseText, citations: null }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 2500, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as never;
      },
    },
  };
}

/* ─── 1. The gateway path: runExploreRequest with a fake explore that runs the real critic ─── */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-gw-critic-'));
const gwSeen: { model?: string; envAtCall?: string | undefined } = {};
const events: AgentEvent[] = [];
delete process.env.QA_CORE_CRITIC_MODEL;
delete process.env.QA_CORE_MODEL_CRITIC;

const fakeExplore = async (opts: ExploreOptions): Promise<RunReport> => {
  // What the runtime does at its critic step, with the fake client in place.
  const c = await critique({ scenarios, url: opts.url, apiKey: 'fake', client: fakeClient(SAUCEDEMO_RESPONSE, gwSeen) });
  opts.onEvent?.({ type: 'critic_done', verdicts: c.verdicts, usd: c.costUsd });
  const report: RunReport = {
    url: opts.url, language: opts.language, scenarios,
    cascadeStats: { role: 2, label: 0, testid: 0, css: 0, placeholder: 2, text: 3, id: 0, name: 0 } as never,
    cost: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0.4, plannerUsd: 0.002, criticUsd: c.costUsd },
    steps: 10, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    plan: scenarios.map((s) => ({ name: s.name, category: s.category ?? 'happy', rationale: 'r', feature: 'login' })),
    review: { verdicts: c.verdicts, summary: c.summary, ...(c.verdicts.length === 0 ? { rawResponse: c.raw } : {}) },
  };
  fs.mkdirSync(opts.outDir, { recursive: true });
  fs.writeFileSync(path.join(opts.outDir, 'run-report.json'), JSON.stringify(report, null, 2));
  return report;
};

const request = { ...defaultExploreRequest(), url: 'https://www.saucedemo.com/', features: ['login'], pom: false, env: { QA_CORE_CRITIC_MODEL: 'claude-sonnet-4-6' } };
const outcome = await runExploreRequest({
  request, projectRoot: root, model: 'claude-opus-4-7',
  onEvent: (e) => events.push(e),
  exploreImpl: fakeExplore,
});

check('A. gateway path: the saucedemo-shaped response parses to 3 verdicts', outcome.report.review?.verdicts.length === 3, JSON.stringify(outcome.report.review?.verdicts));
check('B. gateway path: the rework verdict and its quoted regex survive intact',
  outcome.report.review?.verdicts[2]?.verdict === 'rework' && outcome.report.review?.verdicts[2]?.reasons[0] === 'the URL regex /saucedemo\\.com// has a doubled trailing slash',
  JSON.stringify(outcome.report.review?.verdicts[2]));
check('C. gateway path: the summary parses too', /good shape/.test(outcome.report.review?.summary ?? ''));
check('D. gateway path: the per-run critic model override was in process.env when the critic ran', gwSeen.envAtCall === 'claude-sonnet-4-6' && gwSeen.model === 'claude-sonnet-4-6', JSON.stringify(gwSeen));
check('E. gateway path: the override is restored after the run', process.env.QA_CORE_CRITIC_MODEL === undefined);
check('F. gateway path: the dashboard model chip is NOT applied to the critic', gwSeen.model !== 'claude-opus-4-7');
check('G. gateway path: outcome is a written inline spec with the report path', outcome.kind === 'inline' && !!outcome.specPath && fs.existsSync(outcome.specPath!) && outcome.reportPath.endsWith('run-report.json'));
check('H. gateway path: no raw response kept when verdicts parsed', outcome.report.review?.rawResponse === undefined);
const criticEvent = events.find((e) => e.type === 'critic_done');
check('I. gateway path: critic_done event carries the 3 verdicts', criticEvent?.type === 'critic_done' && criticEvent.verdicts.length === 3);

/* ─── 2. The CLI path: critique with no override ─── */

const cliSeen: { model?: string; envAtCall?: string | undefined } = {};
const cli = await critique({ scenarios, url: 'https://www.saucedemo.com/', apiKey: 'fake', client: fakeClient(SAUCEDEMO_RESPONSE, cliSeen) });
check('J. CLI path: same fixture parses to the same 3 verdicts, byte for byte', JSON.stringify(cli.verdicts) === JSON.stringify(outcome.report.review?.verdicts));
check('K. CLI path: default critic model, no env override present', cliSeen.model === 'claude-sonnet-4-6' && cliSeen.envAtCall === undefined, JSON.stringify(cliSeen));

/* ─── 3. Event forwarding never touches the critic payload ─── */

const forwarded = eventForUi({ type: 'critic_done', verdicts: cli.verdicts, usd: cli.costUsd }) as { verdicts: unknown[] };
check('L. eventForUi forwards critic_done untouched', JSON.stringify(forwarded) === JSON.stringify({ type: 'critic_done', verdicts: cli.verdicts, usd: cli.costUsd }));
const trimmed = eventForUi({ type: 'tool_result', name: 'get_dom', ok: true, data: { html: 'x'.repeat(5000) } }) as { preview?: string; data?: unknown };
check('M. eventForUi trims only tool payloads', trimmed.data === undefined && (trimmed.preview?.length ?? 0) <= 200);

/* ─── 4. The rendering that invited the quote ─── */

const rendered = describeStep(scenarios[2]!.steps[3]!);
check('N. toHaveURL renders as a quoted regex string, never /pattern//', rendered === 'assert URL matches regex "saucedemo\\\\.com/"' && !rendered.includes('//'), rendered);

/* ─── 5. A response nothing can parse keeps the raw text on the report ─── */

const junkSeen: { model?: string; envAtCall?: string | undefined } = {};
const junk = await critique({ scenarios, url: 'https://x.example/', apiKey: 'fake', client: fakeClient('I cannot review this.\n\n<summary>No verdicts.</summary>', junkSeen) });
check('O. an unparseable response yields zero verdicts and the raw text', junk.verdicts.length === 0 && junk.raw.startsWith('I cannot review this.') && junk.summary === 'No verdicts.');

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the critic parse behaves identically on the gateway and CLI paths; a quoted regex in a reason no longer empties the verdict list.');
