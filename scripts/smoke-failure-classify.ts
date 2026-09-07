/**
 * Locks failure classification at the Anthropic call sites
 * (src/agent/checkpoint.ts classifyRunError + the runAgentLoop stop path):
 *   - billing/credit exhaustion classifies 'billing'
 *   - persistent API failures (429/5xx/529, overloaded, connection errors)
 *     classify 'api'
 *   - both stop the Explorer loop CLEANLY (endedReason 'run_stopped',
 *     completed scenarios intact, no throw)
 *   - a generic error classifies 'other' and still throws (a real bug must
 *     never be silently absorbed)
 *   - the salvage summary names the stop cause instead of the ceiling wording
 *
 * Fake-client pattern. No network. No LLM. No browser.
 */
import { classifyRunError, stopMessage } from '../src/agent/checkpoint.js';
import { runAgentLoop, salvageOnCostCeiling } from '../src/agent/runtime.js';
import { createContext } from '../src/agent/tools.js';
import type { Scenario } from '../src/agent/trace.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { Page } from 'playwright';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── A. classification ────────────────────────────────────────────────────── */
check('A1. credit-balance message classifies billing',
  classifyRunError(Object.assign(new Error('Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.'), { status: 400 })).kind === 'billing');
check('A2. insufficient_quota classifies billing',
  classifyRunError({ message: 'insufficient_quota: purchase credits to continue' }).kind === 'billing');
check('A3. HTTP 529 classifies api', classifyRunError(Object.assign(new Error('Overloaded'), { status: 529 })).kind === 'api');
check('A4. HTTP 429 classifies api', classifyRunError(Object.assign(new Error('Too many requests'), { status: 429 })).kind === 'api');
check('A5. connection reset classifies api', classifyRunError(new Error('fetch failed: ECONNRESET')).kind === 'api');
check('A6. overloaded_error type classifies api',
  classifyRunError({ message: '529', error: { error: { type: 'overloaded_error', message: 'Overloaded' } } }).kind === 'api');
check('A7. a generic bug classifies other', classifyRunError(new TypeError('x is not a function')).kind === 'other');
check('A8. classification carries a readable reason',
  /billing\/credit exhaustion/.test(classifyRunError({ message: 'credit balance too low' }).reason));

/* ─── B. billing and api errors stop the loop cleanly ──────────────────────── */
const stubPage = { on: () => {}, off: () => {} } as unknown as Page;
const done = (name: string): Scenario => ({ name, category: 'happy', steps: [] } as unknown as Scenario);

async function loopThatThrows(err: unknown): Promise<{ result?: Awaited<ReturnType<typeof runAgentLoop>>; threw?: string; completed: number }> {
  const ctx = createContext(stubPage, 40);
  ctx.scenarios.push(done('logged in with valid credentials'));
  let calls = 0;
  const client = {
    messages: {
      create: async () => {
        calls++;
        if (calls === 1) {
          return {
            usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            content: [{ type: 'tool_use', id: 't1', name: 'bogus_tool', input: {} }],
            stop_reason: 'tool_use',
          };
        }
        throw err;
      },
    },
  } as unknown as Anthropic;
  try {
    const result = await runAgentLoop({
      client, model: 'claude-opus-4-7', maxUsd: 10,
      price: { in: 5.0, out: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
      maxSteps: 40, ctx, url: 'https://shop.example/', plan: [],
    });
    return { result, completed: ctx.scenarios.length };
  } catch (e) {
    return { threw: (e as Error).message, completed: ctx.scenarios.length };
  }
}

const billing = await loopThatThrows(Object.assign(new Error('Your credit balance is too low to access the Anthropic API.'), { status: 400 }));
check('B1. a billing error does NOT crash the loop', billing.threw === undefined, billing.threw);
check('B2. it ends the loop as run_stopped with kind billing',
  billing.result?.endedReason === 'run_stopped' && billing.result.stop?.kind === 'billing', JSON.stringify(billing.result?.stop));
check('B3. completed scenarios survive the stop', billing.completed === 1);

const api = await loopThatThrows(Object.assign(new Error('Internal server error'), { status: 500 }));
check('B4. a persistent API failure stops cleanly with kind api',
  api.threw === undefined && api.result?.endedReason === 'run_stopped' && api.result.stop?.kind === 'api', JSON.stringify(api.result?.stop));

const bug = await loopThatThrows(new TypeError('boom is not a function'));
check('B5. a generic error still throws (real bugs are never absorbed)',
  bug.threw !== undefined && bug.threw.includes('boom'), bug.threw);

/* ─── C. the salvage summary and stop message name the cause ───────────────── */
const salvage = salvageOnCostCeiling({
  planned: [
    { name: 'logged in with valid credentials', category: 'happy', rationale: 'r' },
    { name: 'rejected a wrong password', category: 'negative', rationale: 'r' },
  ],
  begun: ['logged in with valid credentials'],
  completed: 1,
  costUsd: 1.2,
  ceilingUsd: 5,
  cause: 'billing/credit exhaustion (credit balance too low)',
});
check('C1. the salvage summary names the stop cause, not the ceiling',
  salvage.summary.startsWith('Run stopped (billing/credit exhaustion') && !salvage.summary.includes('Cost ceiling hit'), salvage.summary);
check('C2. the never-explored bookkeeping is identical to the ceiling path',
  salvage.unexplored.length === 1 && salvage.incomplete[0]?.reason.includes('never explored') === true);
check('C3. the resume hint format is stable',
  stopMessage('persistent API failure (HTTP 529)', '/tmp/run/checkpoint.json') ===
  'Run stopped: persistent API failure (HTTP 529). State saved. Resume with: npm run explore -- --resume /tmp/run/checkpoint.json');

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: billing and API failures stop the run cleanly with salvage and a resume hint; genuine bugs still throw.');
