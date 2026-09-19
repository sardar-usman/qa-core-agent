/**
 * Locks the adaptive-timeout measurement anchor (tools.ts + adaptive-timeout.ts).
 *
 * The clock is PAGE time, invariant 55(a): every successful action restarts
 * it with the action's own duration, every later successful call grows it,
 * and the probe's own wait is added. The model's latency between calls is
 * never counted (the old wall-clock anchor counted it, and failed 60s probes
 * inflated the next timeout to 60000 in run f3b41e). So an assert that waits
 * for a fill records the fill window, a late assert after the model's own
 * pause records the floor, and a static check floors. The adaptiveTimeout FORMULA is
 * unchanged — only the duration fed into it.
 *
 * This drives a real headless page through the actual tools and inspects the
 * recorded timeout on the trace step.
 */
import { chromium } from 'playwright';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { ADAPTIVE_FLOOR_MS, ADAPTIVE_CEILING_MS } from '../src/agent/adaptive-timeout.js';
import type { TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

function lastStep(steps: TraceStep[]): TraceStep {
  const s = steps[steps.length - 1];
  if (!s) throw new Error('no steps recorded');
  return s;
}

// Bar fills 0 -> 100 over ~4s (20 ticks of +5 every 200ms) once Start is clicked.
const FILL_MS = 4000;
const animatedBar = `
<!doctype html><html><body>
<button id="start">Start</button>
<div id="progressBar" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">0%</div>
<script>
  document.getElementById('start').addEventListener('click', function () {
    var v = 0;
    var id = setInterval(function () {
      v = Math.min(100, v + 5);
      var b = document.getElementById('progressBar');
      b.setAttribute('aria-valuenow', String(v));
      b.textContent = v + '%';
      if (v >= 100) clearInterval(id);
    }, 200);
  });
</script>
</body></html>`;

const browser = await chromium.launch({ headless: true });
const bctx = await browser.newContext();
await installEvalShim(bctx);
const page = await bctx.newPage();

/* ─── A. An assert that waits for the fill records the fill window ────────── */
// Click Start and assert at once: the probe polls until the bar reaches 100,
// so the page time from the click to the target (~4s) is the observed
// settle and the recorded timeout covers it, never the floor.
await page.setContent(animatedBar, { waitUntil: 'load' });
const tc = createContext(page, 50);
await runTool(tc, { name: 'begin_scenario', input: { name: 'bar completes', category: 'happy', feature: 'progressbar' } });
await runTool(tc, { name: 'click', input: { intent: 'Start button', role: 'button', label: 'Start' } });
const a = await runTool(tc, { name: 'assert', input: { intent: 'progress bar reached 100', css: '#progressBar', type: 'toHaveAttribute', attribute: 'aria-valuenow', value: '100' } });
check('A. toHaveAttribute on the filling bar succeeded once it reached 100', a.ok === true, JSON.stringify(a));

const step = lastStep(tc.current!.steps);
let recorded = -1;
if (step.kind === 'assert' && step.assertion.type === 'toHaveAttribute') recorded = step.assertion.timeout ?? -1;
check('B. recorded an aria-valuenow="100" attribute assertion', step.kind === 'assert' && step.assertion.type === 'toHaveAttribute' && step.assertion.attribute === 'aria-valuenow');
check('C. the timeout is NOT the 5000ms floor: the probe waited for the fill and that page time was measured', recorded > ADAPTIVE_FLOOR_MS,
  `recorded ${recorded}ms`);
check(`D. the timeout covers the ~${FILL_MS}ms fill window`, recorded >= FILL_MS,
  `recorded ${recorded}ms, expected to reflect the ${FILL_MS}ms fill`);
check('E. the timeout is sane (<= adaptive ceiling)', recorded <= ADAPTIVE_CEILING_MS, `recorded ${recorded}ms`);

/* ─── A2. The model's own latency is never counted (invariant 55a) ──────────── */
// Click Start, let the model "think" until the bar is already at 100, THEN
// assert. The settle clock counts page time only (the click's own duration
// plus later successful calls), never the wait between calls, so this
// records the floor; in replay the bar fills from scratch in ~4s, which the
// 5000ms floor covers. The old wall-clock anchor counted the think time and
// inflated the timeout (run f3b41e: three failed 60s probes each pushed the
// next recorded timeout to 60000).
await page.setContent(animatedBar, { waitUntil: 'load' });
const tcLate = createContext(page, 50);
await runTool(tcLate, { name: 'begin_scenario', input: { name: 'bar completes, late assert', category: 'happy', feature: 'progressbar' } });
await runTool(tcLate, { name: 'click', input: { intent: 'Start button', role: 'button', label: 'Start' } });
await new Promise((r) => setTimeout(r, FILL_MS + 600));
const aLate = await runTool(tcLate, { name: 'assert', input: { intent: 'progress bar reached 100', css: '#progressBar', type: 'toHaveAttribute', attribute: 'aria-valuenow', value: '100' } });
const stepLate = lastStep(tcLate.current!.steps);
const recordedLate = stepLate.kind === 'assert' && stepLate.assertion.type === 'toHaveAttribute' ? stepLate.assertion.timeout ?? -1 : -1;
check('A2. a late assert after the model\'s own pause records the floor: the pause is model latency, not page time', aLate.ok === true && recordedLate === ADAPTIVE_FLOOR_MS, `recorded ${recordedLate}ms`);

/* ─── B. A genuinely instant state still floors at 5000 ───────────────────── */
// Anchoring must not inflate an assertion on a static element checked right
// after navigation — the floor is still the right minimum there.
await page.setContent(`<!doctype html><html><body><div id="msg">Ready</div></body></html>`, { waitUntil: 'load' });
const tc2 = createContext(page, 50);
await runTool(tc2, { name: 'begin_scenario', input: { name: 'static text', category: 'happy' } });
const a2 = await runTool(tc2, { name: 'assert', input: { intent: 'message', css: '#msg', type: 'toHaveText', text: 'Ready' } });
const step2 = lastStep(tc2.current!.steps);
let recorded2 = -1;
if (step2.kind === 'assert' && 'timeout' in step2.assertion) recorded2 = (step2.assertion as { timeout?: number }).timeout ?? -1;
check('F. an instant static assertion still floors at 5000ms', a2.ok === true && recorded2 === ADAPTIVE_FLOOR_MS,
  `recorded ${recorded2}ms`);

await browser.close();

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the completion timeout measures page time from the triggering action through the probe, so an assert that waits for the fill records the fill window, the model\'s own pause between calls is never counted, and a static check floors.');
