/**
 * Reproduces the bug seen in the live run:
 *   page with multiple checkboxes → agent passes a css selector that matches
 *   N elements → expects toHaveCount(N) → must succeed (used to fail because
 *   the cascade wrapped the locator in `.first()`, collapsing count to 1).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { transcribe } from '../src/agent/transcriber.js';
import type { RunReport } from '../src/agent/trace.js';

const html = `
<!doctype html><html><body>
<h1>Checkboxes</h1>
<div id="checkboxes">
  <input type="checkbox" id="c1">
  <input type="checkbox" id="c2">
  <input type="checkbox" id="c3">
</div>
</body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext();
  await installEvalShim(ctx);
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: 'load' });

  const tc = createContext(page, 20);
  await runTool(tc, { name: 'begin_scenario', input: { name: 'checkbox count test', category: 'edge' } });

  // The exact shape the live agent used.
  const result = await runTool(tc, {
    name: 'assert',
    input: {
      type: 'toHaveCount',
      intent: 'checkbox inputs',
      css: '#checkboxes input[type=checkbox]',
      count: 3,
      timeout: 15000,
    },
  });
  console.log('assert toHaveCount(3):', JSON.stringify(result));
  if (!result.ok) {
    console.error('FAIL: toHaveCount(3) errored — bug not fixed');
    process.exit(1);
  }

  // Also verify the recorded step has ambiguous stripped (so transcriber emits
  // the call without `.first()`).
  const step = tc.current?.steps[0];
  if (!step || step.kind !== 'assert' || step.assertion.type !== 'toHaveCount') {
    console.error('FAIL: scenario step is not the toHaveCount assertion'); process.exit(1);
  }
  if (step.assertion.target.ambiguous === true) {
    console.error('FAIL: toHaveCount record still has ambiguous=true — would emit .first() in spec'); process.exit(1);
  }
  // The timeout the model passed is recorded on the step (the gate floors a
  // low one at 5000ms); it used to be dropped, so every count check shipped
  // with the floor whatever the model asked for.
  if (step.assertion.timeout !== 15000) {
    console.error(`FAIL: toHaveCount recorded timeout ${String(step.assertion.timeout)}, expected the model's 15000`); process.exit(1);
  }
  console.log('OK: toHaveCount(N) succeeds AND target.ambiguous is not set on the recorded step');

  // Minimum form: toHaveCount with atLeast polls until at least N match. A
  // list that renders 600 ms after load must pass with atLeast: 1 (a one-shot
  // read would see 0), the recorded step carries atLeast, and the emitted spec
  // polls with expect.poll (Playwright has no toHaveCount matcher for "at
  // least"). RULE 7 treats atLeast 1 as the structural "at least one card".
  await page.setContent(`<ul id="list"></ul><script>setTimeout(function(){document.getElementById('list').innerHTML='<li class="card">a</li><li class="card">b</li><li class="card">c</li>';},600);</script>`, { waitUntil: 'load' });
  const tcMin = createContext(page, 20);
  await runTool(tcMin, { name: 'begin_scenario', input: { name: 'the category shows at least one product card', category: 'happy', feature: 'catalogue' } });
  const atLeast = await runTool(tcMin, { name: 'assert', input: { type: 'toHaveCount', intent: 'product cards', css: 'li.card', atLeast: 1, timeout: 5000 } });
  console.log('assert toHaveCount(atLeast 1) on a late-rendered list:', JSON.stringify(atLeast));
  if (!atLeast.ok) { console.error('FAIL: toHaveCount atLeast 1 did not poll the late render'); process.exit(1); }
  const minStep = tcMin.current?.steps[0];
  if (!minStep || minStep.kind !== 'assert' || minStep.assertion.type !== 'toHaveCount' || minStep.assertion.atLeast !== true || minStep.assertion.count !== 1) {
    console.error('FAIL: the recorded step does not carry atLeast: true, count 1: ' + JSON.stringify(minStep)); process.exit(1);
  }
  const tooMany = await runTool(tcMin, { name: 'assert', input: { type: 'toHaveCount', intent: 'product cards', css: 'li.card', atLeast: 9 } });
  if (tooMany.ok !== false || !/RULE 7/.test(tooMany.error ?? '')) { console.error('FAIL: atLeast 9 on product cards must still be a RULE 7 literal count: ' + JSON.stringify(tooMany)); process.exit(1); }
  const exact9 = await runTool(tcMin, { name: 'assert', input: { type: 'toHaveCount', intent: 'product cards', css: 'li.card', count: 3 } });
  if (exact9.ok !== false || !/RULE 7/.test(exact9.error ?? '')) { console.error('FAIL: an exact catalogue count must still be RULE 7 rejected: ' + JSON.stringify(exact9)); process.exit(1); }
  const ended = await runTool(tcMin, { name: 'end_scenario', input: {} });
  if (!ended.ok) { console.error('FAIL: end_scenario rejected the atLeast scenario: ' + JSON.stringify(ended)); process.exit(1); }
  const report: RunReport = {
    url: 'http://example.com/category', language: 'ts', scenarios: tcMin.scenarios,
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    steps: 0, startedAt: '', finishedAt: '',
  };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-hascount-'));
  const { specPath } = transcribe({ report, outDir, name: 'category' });
  const spec = fs.readFileSync(specPath, 'utf8');
  fs.rmSync(outDir, { recursive: true, force: true });
  const pollLine = spec.split('\n').find((l) => /toBeGreaterThanOrEqual\(1\)/.test(l)) ?? '';
  if (!/await expect\.poll\(async \(\) => page\.locator\("li\.card"\)\.count\(\), \{ timeout: \d+ \}\)\.toBeGreaterThanOrEqual\(1\)/.test(pollLine)) {
    console.error('FAIL: the spec must poll the count with expect.poll(...).toBeGreaterThanOrEqual(1); got: ' + pollLine); process.exit(1);
  }
  console.log('emitted: ' + pollLine.trim());
  console.log('OK: toHaveCount atLeast polls a late render, stays RULE 7 clean at 1, and the spec polls the count with a minimum matcher');
} finally {
  await browser.close();
}
