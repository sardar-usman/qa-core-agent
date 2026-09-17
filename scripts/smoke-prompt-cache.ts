/**
 * Locks prompt caching of the Explorer conversation (src/agent/runtime.ts):
 *   - placeCacheBreakpoints marks the last system block and the last content
 *     block of the latest message, removes the previous message marker, and
 *     never exceeds the four breakpoints the API allows per request
 *   - runAgentLoop places the breakpoints on EVERY call: the latest message
 *     carries cache_control on each request the fake client sees, the frozen
 *     system prompt keeps its marker, and exactly one message block is marked
 *   - RunReport.cost records every API call (input, output, cache read, cache
 *     creation) and cachedInputShare, the share of prompt tokens served from
 *     the cache, which is the number that proves the history is cached
 *
 * Driven with a FAKE Anthropic client that records each request and a stub
 * page. No network. No LLM. No browser.
 */
import { runAgentLoop, placeCacheBreakpoints, cachedInputShare } from '../src/agent/runtime.js';
import { createContext } from '../src/agent/tools.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { Page } from 'playwright';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

type Marked = { cache_control?: { type: string } };
const isMarked = (b: unknown): boolean => !!(b as Marked)?.cache_control;
const countMarks = (system: Marked[], messages: Array<{ content: unknown }>): number =>
  system.filter(isMarked).length
  + messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(isMarked).length : 0), 0);

/* ─── A. placement, pure ───────────────────────────────────────────────────── */
{
  const system = [
    { type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'memory', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'plan' },
    { type: 'text', text: 'repair note' },
  ] as unknown as Anthropic.TextBlockParam[];
  const messages = [
    { role: 'user', content: 'Explore https://shop.example/' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'navigate', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"url":"x"}' }] },
  ] as Anthropic.MessageParam[];
  const n = placeCacheBreakpoints(system, messages);
  check('A1. four system blocks plus a conversation use exactly the four allowed breakpoints', n === 4 && countMarks(system as Marked[], messages) === 4, String(n));
  check('A2. the frozen system prompt and the memory block keep their markers', isMarked(system[0]) && isMarked(system[1]));
  check('A3. the plan block is NOT marked; the repair note (last system block) is, covering both', !isMarked(system[2]) && isMarked(system[3]));
  const tail = messages[2]!.content as Marked[];
  check('A4. the latest message\'s last block is marked and no earlier message block is', isMarked(tail[tail.length - 1]) && !isMarked((messages[1]!.content as Marked[])[0]) && typeof messages[0]!.content === 'string');
  // Next round: the marker moves forward and the old one is removed.
  messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'get_dom', input: {} }] });
  messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: '{}' }] });
  const n2 = placeCacheBreakpoints(system, messages);
  check('A5. next call: the message marker moved to the new latest block, the old one is gone, still four', n2 === 4 && !isMarked(tail[tail.length - 1]) && isMarked((messages[4]!.content as Marked[])[0]));
  // A string first message that is also the tail is converted to a block so it can carry the marker.
  const sys2 = [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }] as unknown as Anthropic.TextBlockParam[];
  const first = [{ role: 'user', content: 'Explore https://shop.example/' }] as Anthropic.MessageParam[];
  const n3 = placeCacheBreakpoints(sys2, first);
  check('A6. the first call marks the opening user message (converted to a text block); two breakpoints total', n3 === 2 && Array.isArray(first[0]!.content) && isMarked((first[0]!.content as Marked[])[0]));
}

/* ─── B. the loop places the breakpoints on every call ─────────────────────── */
const requests: Array<{ system: Marked[]; messages: Array<{ role: string; content: unknown }> }> = [];
let calls = 0;
const USAGE = [
  { input_tokens: 1500, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 10877 },
  { input_tokens: 0, output_tokens: 90, cache_read_input_tokens: 12377, cache_creation_input_tokens: 220 },
  { input_tokens: 0, output_tokens: 300, cache_read_input_tokens: 12597, cache_creation_input_tokens: 4900 },
  { input_tokens: 0, output_tokens: 60, cache_read_input_tokens: 17497, cache_creation_input_tokens: 410 },
];
const fakeClient = {
  messages: {
    create: async (params: { system: Marked[]; messages: Array<{ role: string; content: unknown }> }) => {
      // Deep copy: the loop mutates these objects between calls.
      requests.push(JSON.parse(JSON.stringify({ system: params.system, messages: params.messages })));
      const usage = USAGE[calls]!;
      calls++;
      if (calls < USAGE.length) {
        return { usage, content: [{ type: 'tool_use', id: `t${calls}`, name: 'bogus_tool_never_touches_the_page', input: {} }], stop_reason: 'tool_use' };
      }
      return { usage, content: [], stop_reason: 'end_turn' };
    },
  },
} as unknown as Anthropic;
const stubPage = { on: () => {}, off: () => {} } as unknown as Page;
const ctx = createContext(stubPage, 40);
const loop = await runAgentLoop({
  client: fakeClient,
  model: 'claude-opus-4-7',
  maxUsd: 10,
  price: { in: 5.0, out: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  maxSteps: 40,
  ctx,
  url: 'https://shop.example/',
  plan: [{ name: 'logged in', category: 'happy', rationale: 'r', feature: 'login' }],
  repairNote: 'REPAIR PASS. re-record the scenario.',
});
check('B1. four API calls were made', calls === 4 && requests.length === 4, String(calls));
check('B2. EVERY request marks the last block of its latest message', requests.every((r) => {
  const tail = r.messages[r.messages.length - 1]!;
  return Array.isArray(tail.content) && isMarked((tail.content as Marked[])[(tail.content as Marked[]).length - 1]);
}));
check('B3. exactly ONE message block is marked per request (the previous marker is removed)', requests.every((r) => r.messages.reduce((n, m) => n + (Array.isArray(m.content) ? (m.content as Marked[]).filter(isMarked).length : 0), 0) === 1));
check('B4. the frozen system prompt block keeps its marker on every request', requests.every((r) => isMarked(r.system[0])));
check('B5. the last system block (the repair note) is marked; the plan block in between is not', requests.every((r) => isMarked(r.system[r.system.length - 1]) && r.system.length >= 3 && !isMarked(r.system[r.system.length - 2])));
check('B6. the breakpoint count never exceeds four and equals marked system blocks + 1', requests.every((r) => {
  const n = countMarks(r.system, r.messages);
  return n <= 4 && n === r.system.filter(isMarked).length + 1;
}), JSON.stringify(requests.map((r) => countMarks(r.system, r.messages))));
check('B7. the conversation grows call over call (the prefix is appended to, never rebuilt)', requests.every((r, i) => i === 0 || r.messages.length > requests[i - 1]!.messages.length));
check('B8. the conversation prefix is byte-stable: each request starts with the previous one\'s messages (markers aside)', requests.every((r, i) => {
  if (i === 0) return true;
  const strip = (m: unknown): string => JSON.stringify(m, (k, v) => (k === 'cache_control' ? undefined : v));
  const prev = requests[i - 1]!.messages.map(strip);
  return prev.every((m, j) => strip(r.messages[j]) === m);
}));

/* ─── C. the cost record exposes the per-call view and the cache share ─────── */
const c = loop.cost;
check('C1. cost.calls has one entry per API call, in order, exactly as billed',
  c.calls?.length === 4 && c.calls.every((e, i) => e.input === USAGE[i]!.input_tokens && e.output === USAGE[i]!.output_tokens && e.cacheRead === USAGE[i]!.cache_read_input_tokens && e.cacheCreation === USAGE[i]!.cache_creation_input_tokens),
  JSON.stringify(c.calls));
const totals = USAGE.reduce((a, u) => ({ input: a.input + u.input_tokens, read: a.read + u.cache_read_input_tokens, creation: a.creation + u.cache_creation_input_tokens }), { input: 0, read: 0, creation: 0 });
check('C2. the four totals are the sums of the per-call entries', c.inputTokens === totals.input && c.cacheReadTokens === totals.read && c.cacheCreationTokens === totals.creation);
const expectedShare = totals.read / (totals.input + totals.read + totals.creation);
check('C3. cachedInputShare = cacheRead / (input + cacheRead + cacheCreation)', typeof c.cachedInputShare === 'number' && Math.abs(c.cachedInputShare - expectedShare) < 1e-12 && Math.abs(cachedInputShare(c) - expectedShare) < 1e-12, String(c.cachedInputShare));
check('C4. the proving number: past the second call, cache read exceeds input plus cache creation on every call', c.calls!.slice(2).every((e) => e.cacheRead > e.input + e.cacheCreation));
check('C5. an empty record has share 0, never NaN', cachedInputShare({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }) === 0);

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the Explorer conversation carries a moving cache breakpoint on every call, never more than four breakpoints, and the report exposes the cached share per call.');
