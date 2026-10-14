/**
 * Locks the action-first discovery rung for state-dependent pages
 * (invariant 71; src/agent/state-probe.ts, plan-pages.ts, planner.ts,
 * planned-page.ts, rule-coverage.ts).
 *
 * On practicesoftwaretesting.com the header cart link renders only after an
 * add-to-cart, so no crawl of a fresh session finds the cart page (runs 4 to
 * 6). The fixture site below is that shape: "/" lists a product behind a
 * generated-id URL, the product page has an "Add to cart" button, and the
 * header cart link (to /checkout) is rendered by script only after the add.
 * /checkout shows a quantity input only when the cart holds an item.
 *
 *   A. detection ignores a model tag on "/" and finds the cart feature
 *   B. the probe reveals /checkout from "/" through the item hop, with no
 *      model call; discovery.json holds source 'action' and reachedBy, and
 *      no crawled /checkout
 *   C. no trigger, a trigger that reveals nothing, and robots disallowing
 *      /checkout each record their outcome, the whole line, and not-revealed
 *      with the pages tried; a "Place order" control is never clicked
 *   D. two qualifying origins: the stable one wins and both are listed
 *   E. a page the browser crawl read is judged from that load (no reload)
 *   F. the rule split: R6 origin, R7 R8 R9 revealed, a revealed-sense
 *      "added" rule goes revealed because it names "cart page"
 *   G. the run 6 shape: "/" tagged cart by the model pick and the four
 *      Toolshop cart rules. Revealed: R6 planned on "/" with no reachedBy,
 *      R7 R8 R9 on the revealed snapshot, R8 now page-fit. Failed: R6 R7 R9
 *      planned on "/" as on main, only R8 reads not-revealed, and no cited
 *      rule ever reads it. The rule split line and record exist for R8,
 *      which no scenario cites.
 *   H. end_scenario on the runtime's own planned-page entries: R6's trace is
 *      accepted, a navigate to /checkout is refused for every scenario of
 *      the feature, and the click path is accepted
 *   I. one candidate's failure never ends the probe: a disabled "Add to
 *      cart" (out of stock) before or after the good product is named
 *      "trigger disabled" and the probe still reveals /checkout; a later
 *      failure never discards a page that qualified; a trigger click that
 *      throws on the only trigger page ends with outcome error naming the
 *      page and its error; no "no page revealed" detail ever sits beside a
 *      tried entry that says "revealed"
 *   J. a cap that stops the probe names every candidate it did not try
 *   K. a scenario's feature for the refusal comes from its cited rule ids,
 *      never from an exact match on the model's tag ("Shopping-Cart")
 *
 * A local fixture site served in-process (node:http), headless Chromium, a
 * fixture Planner client. No network beyond 127.0.0.1. No model call.
 * Every runTool result is checked (standing rule 7).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { discoverPages, writeDiscoveryJson, type DiscoveredPage } from '../src/agent/discovery.js';
import {
  runStateProbes,
  probeStateFeature,
  disabledTriggers,
  detectStateFeatures,
  splitRulesByPage,
  findTriggers,
  stateProbeLine,
  STATE_PROBE_PAGE_CAP,
  STATE_PROBE_CLICK_CAP,
  type StateProbesResult,
} from '../src/agent/state-probe.js';
import { buildPlanTargets, planAcrossPages } from '../src/agent/plan-pages.js';
import { plan, unreachableFeatures, unreachableFeatureLine, reachedByBlock, type PlannerClient, type PlannedScenario } from '../src/agent/planner.js';
import { computeRuleCoverage, renderRuleCoverage, notRevealedFeatures } from '../src/agent/rule-coverage.js';
import { featureTokenMap, type RequirementsMap } from '../src/agent/requirements.js';
import { plannedPagesFor, reachedPagesOf } from '../src/agent/runtime.js';
import { createContext, runTool } from '../src/agent/tools.js';
import type { TraceStep, SelectorRecord } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

// No model can be called: no key in this process, and the Planner client is a fixture.
delete process.env.ANTHROPIC_API_KEY;

/* ─── the fixture site ──────────────────────────────────────────────────── */

type Variant = 'reveal' | 'no-trigger' | 'no-link' | 'robots' | 'deals' | 'spa' | 'disabled-before' | 'disabled-after' | 'click-throws';
const site = { variant: 'reveal' as Variant, hits: [] as string[] };
const PRODUCT = '/product/01HXXXXXXXXXXXXXXXXXXXXXXX';
// An out-of-stock product: its "Add to cart" is disabled and must never be clicked.
const PRODUCT_OOS = '/product/01HYYYYYYYYYYYYYYYYYYYYYYY';

// The cart link is built by script with split strings, so the fetch crawl's
// href regex never sees it in the page source (only a rendered DOM after an
// add does).
const cartScript = `<script>
function renderCart() {
  var items = JSON.parse(localStorage.getItem('cart') || '[]');
  if (!items.length || document.querySelector('[data-test="nav-cart"]')) return;
  var a = document.createElement('a');
  a.setAttribute('data-test', 'nav-cart');
  a.setAttribute('aria-label', 'cart');
  a.textContent = 'Cart (' + items.length + ')';
  a.setAttribute('hr' + 'ef', '/check' + 'out');
  document.getElementById('cart-slot').appendChild(a);
}
renderCart();
</script>`;
const header = (): string => `<header><nav><a href="/">Home</a> <a href="/contact">Contact</a>${site.variant === 'deals' ? ' <a href="/deals">Deals</a>' : ''} <span id="cart-slot"></span></nav></header>`;
const pageHtml = (title: string, body: string, extra = ''): string => {
  const inner = `${header()}<main>${body}</main>`;
  // The SPA variant renders everything by script, so the fetch crawl sees no anchors and the browser crawl runs.
  const content = site.variant === 'spa'
    ? `<div id="app"></div><script>setTimeout(function () { document.getElementById('app').innerHTML = atob('${Buffer.from(inner).toString('base64')}'); renderCart(); }, 150);</script>`
    : inner;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${content}${cartScript}${extra}</body></html>`;
};
const addScript = `<script>
document.addEventListener('click', function (e) {
  var t = e.target.closest('[data-test]');
  if (!t) return;
  var id = t.getAttribute('data-test');
  if (id === 'add-to-cart' && window.__addReveals !== false) {
    var items = JSON.parse(localStorage.getItem('cart') || '[]');
    items.push({ name: 'Combination Pliers', price: 14.15, qty: 1 });
    localStorage.setItem('cart', JSON.stringify(items));
    renderCart();
  }
  if (id === 'add-to-cart-and-order' || id === 'place-order') fetch('/__hit/place-order');
});
</script>`;

function route(p: string): { status: number; type: string; body: string } {
  const html = (body: string) => ({ status: 200, type: 'text/html; charset=utf-8', body });
  if (p === '/robots.txt') return { status: 200, type: 'text/plain', body: site.variant === 'robots' ? 'User-agent: *\nDisallow: /checkout\n' : 'User-agent: *\nDisallow:\n' };
  if (p === '/') {
    const good = `<a href="${PRODUCT}">Combination Pliers</a><p>$14.15</p>`;
    const oos = `<a href="${PRODUCT_OOS}">Bolt Cutters</a><p>Out of stock</p>`;
    const list = site.variant === 'disabled-before' ? oos + good : site.variant === 'disabled-after' ? good + oos : good;
    return html(pageHtml('Toolshop', `<h1>Toolshop</h1><h2>Products</h2>${list}`));
  }
  if (p === PRODUCT_OOS) return html(pageHtml('Bolt Cutters', `<h1>Bolt Cutters</h1><p>Out of stock</p><button type="button" data-test="add-to-cart" disabled>Add to cart</button>`, addScript));
  // Six stable pages with no trigger, for the page cap.
  if (/^\/plain\/[1-6]$/.test(p)) return html(pageHtml(`Plain ${p.slice(-1)}`, `<h1>Plain page ${p.slice(-1)}</h1>`));
  if (p === '/contact') return html(pageHtml('Contact', `<h1>Contact</h1><form><label for="msg">Message</label><textarea id="msg" name="message"></textarea><button type="button">Send</button></form>`));
  if (p === '/deals') return html(pageHtml('Deals', `<h1>Deals</h1><button type="button" data-test="add-to-cart">Add to cart</button>`, addScript));
  if (p === PRODUCT) {
    const add = site.variant === 'no-trigger' ? '<button type="button">Notify me</button>' : '<button type="button" data-test="add-to-cart">Add to cart</button>';
    const noReveal = site.variant === 'no-link' ? '<script>window.__addReveals = false;</script>' : '';
    // The only trigger click throws: an overlay intercepts every pointer event, so the click times out.
    const overlay = site.variant === 'click-throws' ? '<div style="position:fixed;inset:0;z-index:10;background:transparent"></div>' : '';
    return html(pageHtml('Combination Pliers', `<h1>Combination Pliers</h1><p>$14.15</p>${add}<button type="button" data-test="add-to-cart-and-order">Add to cart and place order</button><button type="button" data-test="place-order">Place order</button>${overlay}`, `${noReveal}${addScript}`));
  }
  if (p === '/checkout') {
    return html(pageHtml('Cart', `<h1>Cart</h1><table id="rows"></table><p id="empty"></p>`, `<script>
var items = JSON.parse(localStorage.getItem('cart') || '[]');
if (!items.length) document.getElementById('empty').textContent = 'Your cart is empty';
items.forEach(function (it) {
  var tr = document.createElement('tr');
  tr.innerHTML = '<td>' + it.name + '</td><td><input type="number" name="quantity" aria-label="Quantity" value="' + it.qty + '"></td><td class="line-total">$' + it.price.toFixed(2) + '</td><td><button type="button">Remove</button></td>';
  document.getElementById('rows').appendChild(tr);
});
</script>`));
  }
  if (p === '/__hit/place-order') return { status: 204, type: 'text/plain', body: '' };
  return { status: 404, type: 'text/plain', body: 'not found' };
}

const server = http.createServer((req, res) => {
  const p = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  site.hits.push(p);
  const r = route(p);
  res.writeHead(r.status, { 'content-type': r.type, 'cache-control': 'no-store' });
  res.end(r.body);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
console.log(`fixture site served in-process from ${base}/ (node:http, in memory)`);

/* ─── the requirements map: the Toolshop cart rules, verbatim ─────────────── */

const map: RequirementsMap = {
  features: [
    { name: 'cart', description: 'The shopping cart.', rules: [
      { id: 'R6', text: 'Adding a product from its detail page increases the cart count shown in the header.', type: 'behavior' },
      { id: 'R7', text: 'The cart page lists each added product with quantity and line total.', type: 'behavior' },
      { id: 'R8', text: 'Changing a quantity on the cart page updates the line total.', type: 'behavior' },
      { id: 'R9', text: 'Removing a product from the cart removes its row and updates the total.', type: 'behavior' },
    ] },
    { name: 'contact', description: 'The contact form.', rules: [
      { id: 'R1', text: 'The contact form shows an error when the message is empty.', type: 'validation' },
    ] },
  ],
  roles: [],
  truncated: false,
};

/** Discovery plus the probes against the current variant, with the smoke's short waits. */
async function discoverAndProbe(): Promise<{ disc: Awaited<ReturnType<typeof discoverPages>>; probes: StateProbesResult; probeHits: string[] }> {
  site.hits = [];
  const disc = await discoverPages({ entryUrl: `${base}/`, crawlDelayMs: 0 });
  const mark = site.hits.length;
  const probes = await runStateProbes({
    map,
    candidates: disc.pages,
    ...(disc.pageControls ? { pageControls: disc.pageControls } : {}),
    ...(disc.robots ? { robots: disc.robots } : {}),
    featureTokens: featureTokenMap(map),
    delayMs: 0,
    anchorWaitMs: 300,
    revealWaitMs: 1500,
    settleCapMs: 2000,
  });
  return { disc, probes, probeHits: site.hits.slice(mark) };
}

const pathOf = (u: string): string => new URL(u).pathname;

/* ─── A. detection ────────────────────────────────────────────────────── */
{
  const candidates: DiscoveredPage[] = [
    { url: `${base}/`, source: 'crawl', feature: 'cart' },
    { url: `${base}/contact`, source: 'crawl' },
    { url: `${base}${PRODUCT}`, source: 'crawl', volatile: true, linkedFrom: `${base}/` },
  ];
  const found = detectStateFeatures(map, candidates, featureTokenMap(map));
  check('A1. detection ignores a model tag on "/" (cart is a candidate) and skips a feature a path carries (contact)',
    found.length === 1 && found[0]!.feature.name === 'cart' && found[0]!.phrases.includes('add to cart'), JSON.stringify(found.map((f) => f.feature.name)));
  const withCartPath = detectStateFeatures(map, [...candidates, { url: `${base}/cart`, source: 'crawl' }], featureTokenMap(map));
  check('A2. a candidate whose path carries the feature (/cart) is page evidence: not probed', withCartPath.length === 0, JSON.stringify(withCartPath.map((f) => f.feature.name)));
  const trig = findTriggers([
    { index: 0, tag: 'button', role: 'button', label: 'Add to cart', testid: 'add-to-cart' },
    { index: 1, tag: 'button', role: 'button', label: 'Add to cart and place order', testid: 'add-to-cart-and-order' },
    { index: 2, tag: 'button', role: 'button', label: 'Pay now' },
  ], ['add to cart']);
  check('A3. findTriggers matches by normalized words, marks a trigger that names "place order" as denied, ignores a non-trigger',
    trig.length === 2 && !trig[0]!.denied && trig[0]!.control === 'getByTestId("add-to-cart")' && trig[1]!.denied === 'place order', JSON.stringify(trig));
  const oosControls = [{ index: 0, tag: 'button', role: 'button' as const, label: 'Add to cart', testid: 'add-to-cart', disabled: true }];
  check('A4. findTriggers skips a disabled trigger; disabledTriggers names it',
    findTriggers(oosControls, ['add to cart']).length === 0 && disabledTriggers(oosControls, ['add to cart'])[0]?.control === 'getByTestId("add-to-cart")');
}

/* ─── B. revealed: /checkout from "/" through the item hop ────────────── */
let revealRun: Awaited<ReturnType<typeof discoverAndProbe>>;
{
  site.variant = 'reveal';
  revealRun = await discoverAndProbe();
  const { disc, probes } = revealRun;
  const product = disc.pages.find((p) => p.url.includes('/product/'));
  check('B0. the fetch crawl found "/", the volatile product (linkedFrom "/") and /contact, and no /checkout',
    disc.method === 'crawl' && product?.volatile === true && product.linkedFrom === `${base}/` && !disc.pages.some((p) => p.url.includes('/checkout')), JSON.stringify(disc.pages));
  const probe = probes.probes[0];
  check('B1. one probe, outcome revealed, /checkout from "/"',
    probes.probes.length === 1 && probe?.outcome === 'revealed' && probe.revealed === `${base}/checkout` && probe.origins[0] === `${base}/`, JSON.stringify(probe));
  const rev = probes.revealed[0];
  check('B2. reachedBy: the item hop, the add-to-cart trigger, the revealed cart link',
    JSON.stringify(rev?.page.reachedBy.actions) === JSON.stringify([{ kind: 'click', via: 'item-link' }, { kind: 'click', control: 'getByTestId("add-to-cart")' }, { kind: 'click', control: 'getByTestId("nav-cart")' }]) && rev?.page.source === 'action' && rev.page.feature === 'cart',
    JSON.stringify(rev?.page));
  check('B3. the probe line names the page, the origin and the actions',
    probes.lines[0] === 'State probe "cart": revealed /checkout from / (click an item, getByTestId("add-to-cart"), getByTestId("nav-cart"))', probes.lines[0]);
  check('B4. the post-action snapshot is the cart with one item: a quantity input is on it',
    !!rev && rev.snapshot.inputs.some((i) => i.type === 'number' && /quantity/i.test(`${i.label ?? ''} ${i.labelText ?? ''}`)), JSON.stringify(rev?.snapshot.inputs));
  check('B5. "/" and /contact read "no trigger" before the product was clicked', probe?.tried.slice(0, 2).every((t) => t.result === 'no trigger') === true && /clicked getByTestId\("add-to-cart"\), revealed \/checkout/.test(probe?.tried.find((t) => t.url.includes('/product/'))?.result ?? ''), JSON.stringify(probe?.tried));
  check(`B6. within the caps: at most ${STATE_PROBE_PAGE_CAP} page loads and ${STATE_PROBE_CLICK_CAP} clicks`,
    revealRun.probeHits.filter((h) => h === '/' || h === '/contact' || h.startsWith('/product/') || h === '/deals').length <= STATE_PROBE_PAGE_CAP && (probe?.tried.filter((t) => t.result.startsWith('clicked')).length ?? 9) <= STATE_PROBE_CLICK_CAP, JSON.stringify(revealRun.probeHits));
  check('B7. the place-order control was never clicked', !site.hits.includes('/__hit/place-order'), JSON.stringify(site.hits));

  // discovery.json, written by the runtime's own writer.
  const built = buildPlanTargets({ pages: [{ url: `${base}/`, source: 'crawl', feature: 'cart' }, { url: `${base}/contact`, source: 'crawl', feature: 'contact' }], map, revealed: probes.revealed, candidates: disc.pages });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-state-probe-'));
  writeDiscoveryJson(dir, { method: disc.method, pages: built.pages, candidates: disc.pages, warnings: disc.warnings, stateProbes: probes.probes });
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'discovery.json'), 'utf8')) as { pages: DiscoveredPage[]; candidates: DiscoveredPage[]; stateProbes: unknown[] };
  const checkoutPage = json.pages.find((p) => p.url === `${base}/checkout`);
  check('B8. discovery.json pages holds /checkout with source action and reachedBy, candidates hold no /checkout, stateProbes recorded',
    checkoutPage?.source === 'action' && checkoutPage.reachedBy?.origin === `${base}/` && !json.candidates.some((p) => p.url.includes('/checkout')) && json.stateProbes.length === 1, JSON.stringify(json));
  console.log('\n--- proof (a): discovery.json stateProbes and pages (reveal variant) ---');
  console.log(JSON.stringify({ stateProbes: json.stateProbes, pages: json.pages }, null, 2));
  console.log('--- proof (b): the probe line and the rule split line ---');
  for (const l of probes.lines) console.log(l);
  console.log('---\n');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ─── C. failures: no trigger, nothing revealed, robots ───────────────── */
let failRun: Awaited<ReturnType<typeof discoverAndProbe>> | undefined;
for (const [variant, outcome, linePart] of [
  ['no-trigger', 'no-trigger', 'never clicked getByTestId("add-to-cart-and-order") (names "place order")'],
  ['no-link', 'no-new-link', 'clicked getByTestId("add-to-cart"), no new cart link within 1500 ms'],
  ['robots', 'robots', 'robots.txt disallows /checkout'],
] as const) {
  site.variant = variant;
  const run = await discoverAndProbe();
  if (variant === 'no-trigger') failRun = run;
  const probe = run.probes.probes[0];
  const line = run.probes.lines[0] ?? '';
  check(`C1 ${variant}. outcome ${outcome}, nothing revealed`, probe?.outcome === outcome && run.probes.revealed.length === 0 && probe.origins.length === 0, JSON.stringify(probe));
  check(`C2 ${variant}. the whole line names every page tried and what happened`,
    line.startsWith('State probe "cart": no page revealed; tried / (no trigger), /contact (no trigger), /product/') && line.includes(linePart) && line.endsWith('any of its 4 rules still uncited after planning will report not-revealed') && line.length > 240, line);
  const cov = computeRuleCoverage({ map, planned: [], scenarios: [], notRevealed: notRevealedFeatures(run.probes.probes) });
  const r8 = cov.uncovered.find((u) => u.ruleId === 'R8');
  check(`C3 ${variant}. an uncited rule reads not-revealed with the pages tried`,
    r8?.reason === 'not-revealed' && (r8.detail ?? '').startsWith('no page revealed: tried /, /contact, /product/') && (variant !== 'robots' || (r8.detail ?? '').includes('robots.txt disallows /checkout')), JSON.stringify(r8));
  check(`C4 ${variant}. the place-order control was never clicked`, !site.hits.includes('/__hit/place-order'));
  check(`C5 ${variant}. no tried entry says "revealed" beside a "no page revealed" detail`, !probe?.tried.some((t) => /\brevealed\b/.test(t.result)), JSON.stringify(probe?.tried));
}

/* ─── D. two qualifying origins: the stable one wins, both listed ─────── */
{
  site.variant = 'deals';
  const { probes } = await discoverAndProbe();
  const probe = probes.probes[0];
  check('D1. both pages qualified and are listed, the stable /deals first, then "/" (the volatile product\'s origin)',
    probe?.outcome === 'revealed' && JSON.stringify(probe.origins) === JSON.stringify([`${base}/deals`, `${base}/`]), JSON.stringify(probe?.origins));
  check('D2. the stable page wins: no item hop in the actions',
    JSON.stringify(probes.revealed[0]?.page.reachedBy) === JSON.stringify({ origin: `${base}/deals`, feature: 'cart', actions: [{ kind: 'click', control: 'getByTestId("add-to-cart")' }, { kind: 'click', control: 'getByTestId("nav-cart")' }] }), JSON.stringify(probes.revealed[0]?.page.reachedBy));
}

/* ─── E. a page the browser crawl read is judged from that load ───────── */
{
  site.variant = 'spa';
  const { disc, probes, probeHits } = await discoverAndProbe();
  check('E1. the SPA shell sends discovery to the browser crawl, which keeps each page\'s controls', disc.method === 'browser-crawl' && !!disc.pageControls && Object.keys(disc.pageControls).length >= 3, JSON.stringify({ method: disc.method, controls: Object.keys(disc.pageControls ?? {}) }));
  check('E2. the probe still reveals /checkout', probes.probes[0]?.outcome === 'revealed' && probes.probes[0].revealed === `${base}/checkout`, JSON.stringify(probes.probes[0]));
  check('E3. "/" and /contact were judged from the crawl\'s load: the probe loaded only the product page', !probeHits.includes('/') && !probeHits.includes('/contact') && probeHits.includes(PRODUCT), JSON.stringify(probeHits));
}


/* ─── I. one candidate's failure never ends the probe ─────────────────── */
console.log('\n--- disabled-trigger and click-failure variants ---');
for (const variant of ['disabled-before', 'disabled-after'] as const) {
  site.variant = variant;
  const { probes } = await discoverAndProbe();
  const probe = probes.probes[0];
  console.log(`${variant}: outcome ${probe?.outcome}`);
  console.log(probes.lines[0]);
  console.log(`tried: ${probe?.tried.map((t) => `${pathOf(t.url)} (${t.result})`).join(', ')}`);
  const oos = probe?.tried.find((t) => t.url.endsWith(PRODUCT_OOS));
  check(`I1 ${variant}. the probe still reveals /checkout`, probe?.outcome === 'revealed' && probe.revealed === `${base}/checkout`, JSON.stringify(probe));
  check(`I2 ${variant}. the out-of-stock page is named in tried as "trigger disabled" with the control`, oos?.result === 'trigger disabled (getByTestId("add-to-cart"))', JSON.stringify(probe?.tried));
  check(`I3 ${variant}. the disabled control was never clicked: the out-of-stock page qualified as nothing`, !probe?.origins.some((o) => o.includes(PRODUCT_OOS)) && !(probe?.tried.some((t) => t.url.endsWith(PRODUCT_OOS) && t.result.startsWith('clicked')) ?? true), JSON.stringify(probe?.tried));
}
{
  site.variant = 'click-throws';
  const { probes } = await discoverAndProbe();
  const probe = probes.probes[0];
  console.log(`click-throws: outcome ${probe?.outcome}`);
  console.log(probes.lines[0]);
  const err = `clicked getByTestId("add-to-cart") failed (locator.click: Timeout 5000ms exceeded)`;
  const entry = probe?.tried.find((t) => t.url.endsWith(PRODUCT));
  check('I4. the only trigger click throws: outcome error', probe?.outcome === 'error' && probes.revealed.length === 0, JSON.stringify(probe));
  check('I5. the failing page is named in tried with the step and the error', entry?.result === err && entry.control === 'getByTestId("add-to-cart")', JSON.stringify(entry));
  check('I6. the detail names that page and its error, then every page tried',
    probe?.detail === `no page revealed: probe error on ${PRODUCT} (${err}); tried /, /contact, ${PRODUCT}`, probe?.detail);
  check('I7. the probe line carries it whole', probes.lines[0] === `State probe "cart": ${probe?.detail}; any of its 4 rules still uncited after planning will report not-revealed`, probes.lines[0]);
}
{
  // A page that qualified is never discarded by a later failure: /deals
  // reveals the cart, then the next candidate's load fails.
  site.variant = 'reveal';
  const browser = await chromium.launch({ headless: true });
  let opened = 0;
  try {
    const r = await probeStateFeature({
      feature: 'cart',
      tokens: ['cart', 'basket', 'checkout'],
      phrases: ['add to cart'],
      candidates: [{ url: `${base}/deals` }, { url: `${base}/zz-after` }],
      delayMs: 0, anchorWaitMs: 300, revealWaitMs: 1500, settleCapMs: 2000,
      openPage: async () => {
        opened++;
        if (opened === 2) {
          const broken = { goto: async () => { throw new Error('page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1/zz-after\nCall log: ...'); } } as unknown as Page;
          return { page: broken, close: async () => {} };
        }
        const ctx = await browser.newContext();
        await installEvalShim(ctx);
        return { page: await ctx.newPage(), close: () => ctx.close() };
      },
    });
    check('I8. a later failure never discards a page that qualified: outcome revealed from /deals',
      r.probe.outcome === 'revealed' && r.probe.origins[0] === `${base}/deals` && r.probe.tried[1]?.result === 'load failed (page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1/zz-after)', JSON.stringify(r.probe));
  } finally {
    await browser.close();
  }
}

/* ─── J. a cap that stops the probe is loud ───────────────────────────── */
{
  site.variant = 'reveal';
  // Six trigger-less stable pages the crawl did not read: every one needs a load.
  const plain = [1, 2, 3, 4, 5, 6].map((n): DiscoveredPage => ({ url: `${base}/plain/${n}`, source: 'crawl' }));
  const r = await runStateProbes({ map, candidates: plain, featureTokens: featureTokenMap(map), delayMs: 0, anchorWaitMs: 200, settleCapMs: 1000 });
  const probe = r.probes[0];
  console.log('\n--- the page cap line ---');
  console.log(r.lines[0]);
  check(`J1. the page cap (${STATE_PROBE_PAGE_CAP}) stopped the loads and names the 2 untried paths`, probe?.capped === `page cap ${STATE_PROBE_PAGE_CAP} reached; not tried: /plain/5, /plain/6` && probe.tried.length === 4, JSON.stringify(probe));
  check('J2. the probe line and the detail carry the cap whole',
    (r.lines[0] ?? '').includes('; page cap 4 reached; not tried: /plain/5, /plain/6; any of its 4 rules') && (probe?.detail ?? '').endsWith('; page cap 4 reached; not tried: /plain/5, /plain/6'), r.lines[0]);
  check('J3. without a cap stop there is no cap note (the reveal variant)', revealRun.probes.probes[0]?.capped === undefined && !revealRun.probes.lines[0]!.includes('cap'));
}

/* ─── F. the rule split ───────────────────────────────────────────────── */
{
  const split = revealRun.probes.probes[0]!.rulesSplit;
  check('F1. R6 origin (names the add, not the cart page); R7 R8 R9 revealed',
    JSON.stringify(split) === JSON.stringify([{ ruleId: 'R6', side: 'origin' }, { ruleId: 'R7', side: 'revealed' }, { ruleId: 'R8', side: 'revealed' }, { ruleId: 'R9', side: 'revealed' }]), JSON.stringify(split));
  check('F2. the split line lists every rule and its side', revealRun.probes.lines[1] === 'State probe "cart" rule split: R6 origin, R7 revealed, R8 revealed, R9 revealed', revealRun.probes.lines[1]);
  const tokens = ['cart', 'basket', 'checkout'];
  const one = splitRulesByPage([{ id: 'RX', text: 'The cart page lists each added product with quantity and line total.' }], { tokens, phrases: ['add to cart'] });
  check('F3. "added" in a revealed-page sense goes revealed because the rule names "cart page"', one[0]?.side === 'revealed', JSON.stringify(one));
  const two = splitRulesByPage([{ id: 'RY', text: 'Adding two items shows 2 on the header badge.' }, { id: 'RZ', text: 'Adding an item lists it under Your Basket.' }], { tokens, phrases: ['add to cart'], revealedHeadings: ['Your Basket'] });
  check('F4. an add rule naming no page is origin; one naming a two-word heading of the revealed page is revealed', two[0]?.side === 'origin' && two[1]?.side === 'revealed', JSON.stringify(two));
}

/* ─── G. the run 6 shape ──────────────────────────────────────────────── */

// The fixture Planner: one line per rule id its REQUIREMENTS block lists,
// the run 5 and 6 names where they exist. It counts its calls and records
// each call's rule ids and whether the reached-by block was in the prompt.
const PLAN_LINES: Record<string, string> = {
  R6: '[cart][happy][R6] added a product from its detail page and the cart count in the header increased — fails if the count does not rise',
  R7: '[cart][happy][R7] opened the cart page from the header and it listed the added product with its line total — fails if the row is missing',
  R8: '[cart][happy][R8] changed a product quantity on the cart page and the line total updated — fails if the total does not change',
  R9: '[cart][happy][R9] removed a product from the cart and its row disappeared and the total updated — fails if the row stays',
  R1: '[contact][negative][R1] rejected the contact form when the message was empty — fails if no error shows',
};
const calls: Array<{ ruleIds: string[]; reachedBlock: boolean }> = [];
const fixtureClient: PlannerClient = {
  messages: {
    create: async (body) => {
      const system = (body.system as Array<{ text: string }>).map((b) => b.text).join('\n');
      const user = String((body.messages[0] as { content: string }).content);
      const ids = [...system.matchAll(/^\s+(R\d+) \[/gm)].map((m) => m[1]!);
      calls.push({ ruleIds: ids, reachedBlock: user.includes('This page exists only after an action') });
      const text = ids.map((id, i) => `${i + 1}. ${PLAN_LINES[id] ?? ''}`).join('\n');
      return { content: [{ type: 'text', text, citations: null }], usage: { input_tokens: 0, output_tokens: 0 } } as unknown as Awaited<ReturnType<PlannerClient['messages']['create']>>;
    },
  },
};

/** Plan the run 6 page set (the model pick tagged "/" cart) through the runtime's own chain. */
async function planRun6(probes: StateProbesResult, candidates: DiscoveredPage[]): Promise<{ plan: PlannedScenario[]; lines: string[]; pages: DiscoveredPage[] }> {
  const lines: string[] = [];
  const filtered: DiscoveredPage[] = [{ url: `${base}/`, source: 'crawl', feature: 'cart' }, { url: `${base}/contact`, source: 'crawl', feature: 'contact' }];
  const built = buildPlanTargets({ pages: filtered, map, revealed: probes.revealed, candidates });
  const r = await planAcrossPages({ targets: built.targets, planFn: (a) => plan({ ...a, client: fixtureClient }), onMessage: (t) => lines.push(t) });
  return { plan: r.combined, lines, pages: built.pages };
}
const cites = (p: PlannedScenario[], id: string): PlannedScenario | undefined => p.find((s) => (s.ruleIds ?? []).includes(id));

{
  site.variant = 'reveal';
  calls.length = 0;
  const g = await planRun6(revealRun.probes, revealRun.disc.pages);
  const r6 = cites(g.plan, 'R6');
  check('G1. revealed: R6 is planned on "/" with no reachedBy', r6?.pageUrl === `${base}/` && r6.reachedBy === undefined, JSON.stringify(r6));
  const revealedOnes = ['R7', 'R8', 'R9'].map((id) => cites(g.plan, id));
  check('G2. revealed: R7 R8 R9 are planned on the revealed snapshot, pageUrl the origin, reachedBy.pageUrl /checkout',
    revealedOnes.every((s) => s?.pageUrl === `${base}/` && s.reachedBy?.pageUrl === `${base}/checkout` && s.reachedBy.origin === `${base}/`), JSON.stringify(revealedOnes));
  check('G3. revealed: R8 (quantity on the cart page) now passes page-fit', !!cites(g.plan, 'R8') && !g.lines.some((l) => l.startsWith('Rejected page-fit scenario') && l.includes('quantity')), JSON.stringify(g.lines));
  check('G4. the "/" call got only R6 of the cart rules; the revealed call got R7 R8 R9 and the reached-by block; contact unchanged',
    JSON.stringify(calls) === JSON.stringify([{ ruleIds: ['R6'], reachedBlock: false }, { ruleIds: ['R7', 'R8', 'R9'], reachedBlock: true }, { ruleIds: ['R1'], reachedBlock: false }]), JSON.stringify(calls));
  check('G5. the revealed page is planned right after its origin, and its Planner line says so',
    g.lines.some((l) => l.startsWith(`Planner [2/3] ${base}/checkout (reached by action from ${base}/): 3 scenario(s)`)), JSON.stringify(g.lines));
  const cov = computeRuleCoverage({ map, planned: g.plan, scenarios: [], notRevealed: notRevealedFeatures(revealRun.probes.probes) });
  check('G6. revealed: no rule reads not-revealed', !cov.uncovered.some((u) => u.reason === 'not-revealed'), JSON.stringify(cov.uncovered));
  const untagged = [{ feature: 'contact' }];
  check('G7. the unreachable-feature line is not printed for a probed feature (and is without the probe)',
    unreachableFeatures(map, untagged, revealRun.probes.probes).length === 0 && unreachableFeatures(map, untagged).some((f) => f.name === 'cart'), JSON.stringify(unreachableFeatures(map, untagged)));
  check('G8. reachedByBlock names the origin, the steps, and that /checkout is never navigated to',
    reachedByBlock(`${base}/checkout`, revealRun.probes.revealed[0]!.page.reachedBy).includes(`the Explorer never navigates to /checkout directly`));
  console.log('\n--- proof (c): rule coverage, reveal variant, counting every planned scenario as shipped (no Explorer runs here) ---');
  for (const l of renderRuleCoverage(computeRuleCoverage({ map, planned: g.plan, scenarios: g.plan, notRevealed: notRevealedFeatures(revealRun.probes.probes) }))) console.log(l);

  /* H. end_scenario on the runtime's own entries */
  const stubPage = { on: () => {}, off: () => {} } as unknown as Page;
  const ctx = createContext(stubPage, 80);
  ctx.plannedNames = g.plan.map((p) => p.name);
  ctx.plannedPages = plannedPagesFor(g.plan, reachedPagesOf({ method: 'crawl', pages: [], warnings: [], stateProbes: revealRun.probes.probes }), map);
  check('H0. every cart scenario carries reachedPageUrl /checkout, the contact one none',
    g.plan.every((p) => (ctx.plannedPages.get(p.name)?.reachedPageUrl === `${base}/checkout`) === (p.feature === 'cart')), JSON.stringify([...ctx.plannedPages]));
  const target: SelectorRecord = { level: 'role', arg: { role: 'heading', name: 'Cart' }, intent: 'cart heading' };
  const nav = (u: string): TraceStep => ({ kind: 'navigate', url: u });
  const click = (): TraceStep => ({ kind: 'click', target } as TraceStep);
  const assertVisible = (): TraceStep => ({ kind: 'assert', assertion: { type: 'toBeVisible', target } } as unknown as TraceStep);
  const drive = async (name: string, steps: TraceStep[], label: string) => {
    const begun = await runTool(ctx, { name: 'begin_scenario', input: { name, category: 'happy', feature: 'cart' } });
    check(`${label} begin_scenario accepted`, begun.ok === true, begun.error);
    ctx.current!.steps.push(...steps);
    return runTool(ctx, { name: 'end_scenario', input: {} });
  };
  const r6res = await drive(r6!.name, [nav(`${base}/`), click(), click(), assertVisible()], 'H1.');
  check('H1. R6 (origin rule, no reachedBy): navigate "/", click through, assert: accepted', r6res.ok === true, r6res.error);
  const r7 = cites(g.plan, 'R7')!;
  const bad = await drive(r7.name, [nav(`${base}/`), click(), nav(`${base}/checkout`), assertVisible()], 'H2.');
  check('H2. a revealed-page rule whose trace navigates to /checkout is refused as navigated-to-reached-page, with the three ways out',
    bad.ok === false && /navigated to \/checkout, a page that is reached by action from \//.test(bad.error ?? '') && /\/checkout exists only after an action: open \//.test(bad.error ?? '') && /\(1\) restart with begin_scenario/.test(bad.error ?? ''), bad.error);
  const good = await drive(r7.name, [nav(`${base}/`), click(), click(), click(), assertVisible()], 'H3.');
  check('H3. the same scenario by the click path is accepted', good.ok === true, good.error);
  const r9 = cites(g.plan, 'R9')!;
  const b1 = await drive(r9.name, [nav(`${base}/checkout`), assertVisible()], 'H4a.');
  const b2 = await drive(r9.name, [nav(`${base}/checkout`), assertVisible()], 'H4b.');
  check('H4. the second navigate to /checkout for the same scenario goes to brokenByGate (invariant 65 strike rule)',
    b1.ok === false && b2.ok === false && ctx.brokenByGate.some((b) => b.scenario === r9.name && /reached by action/.test(b.reason)), JSON.stringify(ctx.brokenByGate));
  const r6again = await drive(r6!.name, [nav(`${base}/`), nav(`${base}/checkout`), assertVisible()], 'H5.');
  check('H5. an origin scenario of the feature (R6) is refused for a navigate to /checkout too: no exemption', r6again.ok === false && /navigated-to-reached-page|reached by action/.test(r6again.error ?? ''), r6again.error);
}

{
  // Failed probe (no trigger): planning is exactly as on main.
  site.variant = 'no-trigger';
  calls.length = 0;
  const run = failRun!;
  const g = await planRun6(run.probes, run.disc.pages);
  const baseline = await planRun6({ probes: [], revealed: [], lines: [] }, run.disc.pages);
  check('G9. failed: the plan is the one main makes (same names, pages and citations as with no probe at all)',
    JSON.stringify(g.plan) === JSON.stringify(baseline.plan), JSON.stringify({ g: g.plan.map((p) => p.name), baseline: baseline.plan.map((p) => p.name) }));
  for (const id of ['R6', 'R7', 'R9']) {
    const s = cites(g.plan, id);
    check(`G10 ${id}. failed: still planned on "/" as on main, no reachedBy`, s?.pageUrl === `${base}/` && s.reachedBy === undefined, JSON.stringify(s));
  }
  check('G11. failed: R8 is rejected by page-fit on "/" (no quantity there)', !cites(g.plan, 'R8') && g.lines.some((l) => l.startsWith('Rejected page-fit scenario: "changed a product quantity on the cart page and the line total updated"') && l.includes('quantity')), JSON.stringify(g.lines));
  const cov = computeRuleCoverage({ map, planned: g.plan, scenarios: [], notRevealed: notRevealedFeatures(run.probes.probes) });
  const r8 = cov.uncovered.find((u) => u.ruleId === 'R8');
  check('G12. failed: only R8 reads not-revealed, with the probe detail', r8?.reason === 'not-revealed' && cov.uncovered.filter((u) => u.reason === 'not-revealed').length === 1, JSON.stringify(cov.uncovered));
  const citedIds = new Set(g.plan.flatMap((p) => p.ruleIds ?? []));
  check('G13. no cited rule reads not-revealed', !cov.uncovered.some((u) => citedIds.has(u.ruleId) && u.reason === 'not-revealed'), JSON.stringify(cov.uncovered));
  const probe = run.probes.probes[0]!;
  check('G14. the rule split record and line exist for R8, which no scenario cites',
    !citedIds.has('R8') && probe.rulesSplit.some((r) => r.ruleId === 'R8' && r.side === 'revealed') && run.probes.lines[1]?.includes('R8 revealed') === true, JSON.stringify({ split: probe.rulesSplit, line: run.probes.lines[1] }));
  check('G15. the not-revealed line is the probe line, not "no discovered page"', stateProbeLine(probe) === run.probes.lines[0] && !run.probes.lines.some((l) => l === unreachableFeatureLine({ name: 'cart', rules: 4 })));
  console.log('\n--- proof (c): rule coverage, fail variant (no trigger), counting every planned scenario as shipped (no Explorer runs here) ---');
  for (const l of renderRuleCoverage(computeRuleCoverage({ map, planned: g.plan, scenarios: g.plan, notRevealed: notRevealedFeatures(run.probes.probes) }))) console.log(l);
  console.log('--- proof (b): the probe line and the rule split line, fail variant ---');
  for (const l of run.probes.lines) console.log(l);
  console.log('---\n');
}


/* ─── K. the refusal's feature comes from cited rule ids, never the tag ─── */
{
  const checkout = `${base}/checkout`;
  const reached = reachedPagesOf({ method: 'crawl', pages: [], warnings: [], stateProbes: revealRun.probes.probes });
  const shoppingCart: PlannedScenario = { name: 'added the pliers and the header count went up', category: 'happy', feature: 'Shopping-Cart', ruleIds: [' r6'], rationale: 'r', pageUrl: `${base}/` };
  const contactOnly: PlannedScenario = { name: 'rejected the contact form with an empty message', category: 'negative', feature: 'cart', ruleIds: ['R1'], rationale: 'r', pageUrl: `${base}/contact` };
  const tagOnly: PlannedScenario = { name: 'cart link shows after an add', category: 'happy', feature: ' Cart ', rationale: 'r', pageUrl: `${base}/` };
  const entries = plannedPagesFor([shoppingCart, contactOnly, tagOnly], reached, map);
  console.log('\n--- the "Shopping-Cart" check ---');
  console.log(JSON.stringify({ shoppingCart: entries.get(shoppingCart.name), contactOnly: entries.get(contactOnly.name), tagOnly: entries.get(tagOnly.name) }));
  check('K1. tagged "Shopping-Cart" citing R6, no reachedBy: reachedPageUrl /checkout (from the rule, not the tag)', entries.get(shoppingCart.name)?.reachedPageUrl === checkout, JSON.stringify(entries.get(shoppingCart.name)));
  check('K2. tagged "cart" but citing only the contact rule R1: no reachedPageUrl', entries.get(contactOnly.name)?.reachedPageUrl === undefined, JSON.stringify(entries.get(contactOnly.name)));
  check('K3. citing no rule, the tag " Cart " is normalized before it is compared: reachedPageUrl /checkout', entries.get(tagOnly.name)?.reachedPageUrl === checkout);
  const stubPage = { on: () => {}, off: () => {} } as unknown as Page;
  const ctx = createContext(stubPage, 80);
  ctx.plannedNames = [shoppingCart.name, contactOnly.name, tagOnly.name];
  ctx.plannedPages = entries;
  const target: SelectorRecord = { level: 'role', arg: { role: 'heading', name: 'Cart' }, intent: 'cart heading' };
  const begun = await runTool(ctx, { name: 'begin_scenario', input: { name: shoppingCart.name, category: 'happy', feature: 'Shopping-Cart' } });
  check('K4. begin_scenario accepted', begun.ok === true, begun.error);
  ctx.current!.steps.push({ kind: 'navigate', url: `${base}/` } as TraceStep, { kind: 'navigate', url: checkout } as TraceStep, { kind: 'assert', assertion: { type: 'toBeVisible', target } } as unknown as TraceStep);
  const res = await runTool(ctx, { name: 'end_scenario', input: {} });
  console.log(`end_scenario: ok=${String(res.ok)} error=${res.error}`);
  check('K5. its trace with a navigate to /checkout is refused as navigated-to-reached-page', res.ok === false && /navigated to \/checkout, a page that is reached by action from \//.test(res.error ?? ''), res.error);
}

server.close();

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the state probe reveals a page that exists only after an action, records it as reached by that action, plans its rules from the post-action snapshot, refuses a navigate to it, and when it reveals nothing leaves planning as on main with only uncited rules reading not-revealed.');
