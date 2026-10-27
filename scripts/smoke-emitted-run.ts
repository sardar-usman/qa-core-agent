/**
 * Locks standing rule 4: compiled is not executed. The emitted framework is
 * RUN, in both languages, against a page that satisfies every assertion.
 *
 * What happens here:
 *   1. A fixture run-report uses every emitted shape: navigate, fill (literal
 *      and generated unique data), click, select_option, set_checked,
 *      toHaveURL, toHaveText literal and pattern, toContainText, toHaveValue,
 *      toHaveAttribute pattern, toBeChecked, toHaveCount 0 and atLeast,
 *      capture plus assert_compare with changed, greater on a currency string,
 *      equal and changed on every row of the shared sameValue table plus run
 *      59540f's "$14.15" listing against "14.15" detail (invariant 76),
 *      and on a cart badge's text (run 44cb3d: a counter is read by its text,
 *      never as a literal or an element count), equal against a different
 *      target, and a frame chain. A cart feature reached by action
 *      (invariant 71): the cart link renders only after an add, and the
 *      cart page is reached by clicking through from the shop page.
 *      The emitted specs, POM and single file in TS and JS, hold no
 *      page.goto on the revealed URL.
 *   2. A small static site is served from a local port by this process
 *      (node:http, in memory, no files on disk) so the shipped tests have
 *      something real to drive. The assertions are true on that site.
 *   3. scaffold() writes the TS framework and the JS framework into temporary
 *      directories, `npm install` runs in each (npm cache first, the registry
 *      only when the cache cannot satisfy the pins), then `npx playwright test`
 *      with the list and JSON reporters.
 *   4. OK: prints only when Playwright's own exit code is 0 for both languages,
 *      the JSON report shows zero unexpected and zero flaky results, every
 *      scenario passed, and the a11y spec ran and passed.
 *
 * The child runs are spawned asynchronously so this process keeps serving
 * the fixture pages while Playwright drives them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { scaffold } from '../src/agent/scaffold.js';
import { transcribe } from '../src/agent/transcriber.js';
import type { RunReport, Scenario, SelectorRecord } from '../src/agent/trace.js';
import { SAME_VALUE_CASES } from './lib/same-value-cases.js';
import { readTree, emptyTextHits } from './lib/emitted-runner.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

/* ─── 1. the fixture site, served from memory ───────────────────────────── */

const indexHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Toolshop fixture</title></head>
<body>
<main>
  <h1 data-test="page-title">Hand Tools</h1>
  <form id="contact" aria-label="Contact form">
    <label for="name">Name</label> <input id="name" name="name">
    <label for="subject">Subject</label>
    <select id="subject" name="subject"><option value="">Choose</option><option value="warranty">Warranty</option><option value="return">Return</option></select>
    <label><input type="checkbox" id="eco" name="eco"> Eco-friendly</label>
    <button type="submit" id="send">Send</button>
  </form>
  <div id="products">
    <a class="card" href="/detail.html" data-test="product-1"><img class="card-img-top" src="/assets/products/sander.svg" alt="Sheet Sander"><h5>Sheet Sander</h5><span class="card-footer">$4.92</span></a>
    <a class="card" href="/detail.html" data-test="product-2"><img class="card-img-top" src="/assets/products/sander.svg" alt="Combination Pliers"><h5>Combination Pliers</h5><span class="card-footer">$14.15</span></a>
  </div>
  <button type="button" id="sort">Sort by price high to low</button>
  <button type="button" id="tok-1">Regenerate</button>
  <a href="/register.html" id="create-account">Create account</a>
  <iframe id="frame1" title="Sample frame" src="/frame.html"></iframe>
</main>
<script>
  document.getElementById('contact').addEventListener('submit', function (e) {
    e.preventDefault();
    var d = document.createElement('div'); d.setAttribute('role', 'alert'); d.textContent = 'Thanks for your message, ' + document.getElementById('name').value + '.';
    document.querySelector('main').appendChild(d);
  });
  document.getElementById('sort').addEventListener('click', function () {
    document.querySelector('.card .card-footer').textContent = '$48.41';
  });
  document.getElementById('tok-1').addEventListener('click', function () {
    this.id = 'tok-' + Date.now();
  });
</script>
</body></html>`;

const detailHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sheet Sander</title></head>
<body><main>
  <h1 data-test="product-name">Sheet Sander</h1>
  <span data-test="unit-price">$4.92</span>
  <h2>Related products</h2>
  <a class="card" href="/detail.html"><h5>Random Orbit Sander</h5><span class="card-footer">$12.00</span></a>
</main></body></html>`;

const frameHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Frame</title></head>
<body><h1 id="sampleHeading">Sample Heading</h1></body></html>`;

const registerHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Register</title></head>
<body><main>
  <h1>Create account</h1>
  <form id="register" aria-label="Registration form">
    <label for="email">Email</label> <input id="email" name="email" type="email">
    <label for="password">Password</label> <input id="password" name="password" type="password">
    <button type="submit">Register</button>
  </form>
</main>
<script>
  document.getElementById('register').addEventListener('submit', function (e) {
    e.preventDefault();
    var d = document.createElement('div'); d.setAttribute('role', 'alert'); d.textContent = 'Welcome, ' + document.getElementById('email').value;
    document.querySelector('main').appendChild(d);
  });
</script>
</body></html>`;

// A list that renders 800 ms after load, a filter that hides some of its cards,
// and a badge that does not exist until the first add. Run 44cb3d's emitted
// eco-filter test read the card count before the list rendered (0), so the
// less compare could not hold ("Expected: < 0 Received: 2"); the emitted count
// capture must wait the way replay does (invariant 39).
const delayedHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Delayed list</title></head>
<body><main>
  <h1>Rentals</h1>
  <button type="button" id="filter">Light tools only</button>
  <button type="button" id="add">Add to cart</button>
  <div id="list"></div>
</main>
<script>
  var filtered = false;
  var ready = false;
  function render() {
    var list = document.getElementById('list');
    list.innerHTML = '';
    [{ n: 'Hammer', heavy: true }, { n: 'Pliers', heavy: false }, { n: 'Saw', heavy: true }, { n: 'Wrench', heavy: false }].forEach(function (it) {
      if (filtered && it.heavy) return;
      var d = document.createElement('div'); d.className = 'item'; d.textContent = it.n; list.appendChild(d);
    });
  }
  setTimeout(function () { ready = true; render(); }, 800);
  document.getElementById('filter').addEventListener('click', function () { filtered = true; if (ready) render(); });
  document.getElementById('add').addEventListener('click', function () {
    var b = document.getElementById('badge');
    if (!b) { b = document.createElement('span'); b.id = 'badge'; b.textContent = '1'; document.querySelector('main').appendChild(b); }
    else { b.textContent = String(Number(b.textContent) + 1); }
  });
</script>
</body></html>`;

// A page that exists only after an action (invariant 71): the cart link is
// built by script after an add, from split strings so no crawl of the page
// source finds it, and the cart page lists what localStorage holds.
const cartLinkScript = `<script>
function renderCart() {
  var items = JSON.parse(localStorage.getItem('cart') || '[]');
  if (!items.length || document.querySelector('[data-test="nav-cart"]')) return;
  var a = document.createElement('a');
  a.setAttribute('data-test', 'nav-cart');
  a.textContent = 'Cart';
  a.setAttribute('hr' + 'ef', '/check' + 'out');
  document.getElementById('cart-slot').appendChild(a);
}
renderCart();
</script>`;
const shopHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Shop</title></head>
<body><header><span id="cart-slot"></span></header><main>
  <h1>Shop</h1>
  <a href="/item.html">Combination Pliers</a>
</main>${cartLinkScript}</body></html>`;
const itemHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Combination Pliers</title></head>
<body><header><span id="cart-slot"></span></header><main>
  <h1>Combination Pliers</h1>
  <button type="button" data-test="add-to-cart">Add to cart</button>
</main>${cartLinkScript}
<script>
  document.querySelector('[data-test="add-to-cart"]').addEventListener('click', function () {
    var items = JSON.parse(localStorage.getItem('cart') || '[]');
    items.push({ name: 'Combination Pliers', qty: 1 });
    localStorage.setItem('cart', JSON.stringify(items));
    renderCart();
  });
</script></body></html>`;
const checkoutHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Cart</title></head>
<body><main><h1>Cart</h1><table id="rows"></table></main>
<script>
  JSON.parse(localStorage.getItem('cart') || '[]').forEach(function (it) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + it.name + '</td><td><input type="number" aria-label="Quantity" value="' + it.qty + '"></td>';
    document.getElementById('rows').appendChild(tr);
  });
</script></body></html>`;

// Mixed attributes (invariant 73): one control carries data-test, the other
// Playwright's default data-testid, so the framework keeps css for the first
// and the default getByTestId for the second, with no testIdAttribute.
const mixedHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mixed ids</title></head>
<body><main><h1>Mixed</h1>
  <button type="button" data-test="go">Go</button>
  <span data-testid="status"></span>
</main>
<script>
  document.querySelector('[data-test="go"]').addEventListener('click', function () {
    document.querySelector('[data-testid="status"]').textContent = 'Done';
  });
</script></body></html>`;

// equal, unchanged and changed on formatted numbers (invariant 76): one pair
// of elements per row of the shared sameValue table, and run 59540f's shape,
// a listing that shows "$14.15" and a detail page that shows "14.15".
const escapeHtml = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const valuesHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Values</title></head>
<body><main><h1>Values</h1>
${SAME_VALUE_CASES.map((c, i) => `  <p><span id="cap-${i}">${escapeHtml(c.captured)}</span> <span id="now-${i}">${escapeHtml(c.current)}</span></p>`).join('\n')}
</main></body></html>`;
const priceListHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Price list</title></head>
<body><main><h1>Pliers</h1>
  <a href="/price-detail.html" data-test="price-card"><h5>Combination Pliers</h5><span data-test="listing-price">$14.15</span></a>
</main></body></html>`;
const priceDetailHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Combination Pliers</title></head>
<body><main><h1>Combination Pliers</h1><span data-test="unit-price">14.15</span></main></body></html>`;

const sanderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#888"/></svg>`;

const routes: Record<string, { body: string; type: string }> = {
  '/': { body: indexHtml, type: 'text/html; charset=utf-8' },
  '/index.html': { body: indexHtml, type: 'text/html; charset=utf-8' },
  '/detail.html': { body: detailHtml, type: 'text/html; charset=utf-8' },
  '/frame.html': { body: frameHtml, type: 'text/html; charset=utf-8' },
  '/register.html': { body: registerHtml, type: 'text/html; charset=utf-8' },
  '/delayed.html': { body: delayedHtml, type: 'text/html; charset=utf-8' },
  '/assets/products/sander.svg': { body: sanderSvg, type: 'image/svg+xml' },
  '/shop.html': { body: shopHtml, type: 'text/html; charset=utf-8' },
  '/item.html': { body: itemHtml, type: 'text/html; charset=utf-8' },
  '/checkout': { body: checkoutHtml, type: 'text/html; charset=utf-8' },
  '/mixed.html': { body: mixedHtml, type: 'text/html; charset=utf-8' },
  '/values.html': { body: valuesHtml, type: 'text/html; charset=utf-8' },
  '/price-list.html': { body: priceListHtml, type: 'text/html; charset=utf-8' },
  '/price-detail.html': { body: priceDetailHtml, type: 'text/html; charset=utf-8' },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const route = routes[url.pathname];
  if (!route) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': route.type, 'cache-control': 'no-store' });
  res.end(route.body);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
console.log(`fixture site served in-process from ${base}/ (node:http, in memory)`);

/* ─── 2. the fixture run-report: every emitted shape ────────────────────── */

// Every exact test-id selector the main fixture records uses data-test and
// none sits at level testid, so the framework emits getByTestId with
// testIdAttribute: 'data-test' (invariant 73). The resolver records a
// data-test match as css (selectors.ts step 7), which is what these are.
const pageTitle: SelectorRecord = { level: 'css', arg: '[data-test="page-title"]', intent: 'page title' };
const productCardsByPrefix: SelectorRecord = { level: 'css', arg: 'a[data-test^="product-"]', intent: 'product cards by test id prefix' };
const cards: SelectorRecord = { level: 'css', arg: '.card', intent: 'product cards' };
const cardPrice: SelectorRecord = { level: 'css', arg: '.card .card-footer', intent: 'first card price', ambiguous: true };
const cardName: SelectorRecord = { level: 'css', arg: '.card h5', intent: 'first card name', ambiguous: true };
const cardImage: SelectorRecord = { level: 'css', arg: '.card img', intent: 'first card image', ambiguous: true };
const firstCard: SelectorRecord = { level: 'css', arg: 'a.card', intent: 'first product card', ambiguous: true };
const noSuch: SelectorRecord = { level: 'css', arg: '[data-test="no-such"]', intent: 'sold-out banner' };
const sortButton: SelectorRecord = { level: 'role', arg: { role: 'button', name: 'Sort by price high to low' }, intent: 'sort button' };
const regenButton: SelectorRecord = { level: 'role', arg: { role: 'button', name: 'Regenerate' }, intent: 'regenerate button' };
const detailHeading: SelectorRecord = { level: 'css', arg: 'h1', intent: 'detail heading' };
const nameInput: SelectorRecord = { level: 'label', arg: 'Name', intent: 'name input' };
const subjectSelect: SelectorRecord = { level: 'label', arg: 'Subject', intent: 'subject select' };
const ecoBox: SelectorRecord = { level: 'css', arg: '#eco', intent: 'eco-friendly checkbox' };
const sendButton: SelectorRecord = { level: 'role', arg: { role: 'button', name: 'Send' }, intent: 'send button' };
const alertBox: SelectorRecord = { level: 'role', arg: { role: 'alert' }, intent: 'confirmation alert' };
const frameHeading: SelectorRecord = { level: 'css', arg: '#sampleHeading', intent: 'frame heading', frameChain: ['iframe#frame1'] };
const emailInput: SelectorRecord = { level: 'label', arg: 'Email', intent: 'email input' };
const passwordInput: SelectorRecord = { level: 'label', arg: 'Password', intent: 'password input' };
const registerButton: SelectorRecord = { level: 'role', arg: { role: 'button', name: 'Register' }, intent: 'register button' };
const createAccountLink: SelectorRecord = { level: 'role', arg: { role: 'link', name: 'Create account' }, intent: 'create account link' };
// Two intent-less assertions on DIFFERENT locators in one feature: the tool
// used to default the intent to "element" (run 51d535), and a field keyed by
// intent merged them into one locator. Each must land in its own field.
const headingNoIntent: SelectorRecord = { level: 'css', arg: 'h1', intent: 'element' };
const delayedItems: SelectorRecord = { level: 'css', arg: '.item', intent: 'product cards' };
const filterButton: SelectorRecord = { level: 'role', arg: { role: 'button', name: 'Light tools only' }, intent: 'filter button' };
const addButton: SelectorRecord = { level: 'role', arg: { role: 'button', name: 'Add to cart' }, intent: 'add to cart button' };
const cartBadge: SelectorRecord = { level: 'css', arg: '#badge', intent: 'cart badge' };
const sendNoIntent: SelectorRecord = { level: 'css', arg: '#send', intent: 'element' };
const itemLink: SelectorRecord = { level: 'role', arg: { role: 'link', name: 'Combination Pliers' }, intent: 'product link' };
const addToCart: SelectorRecord = { level: 'css', arg: '[data-test="add-to-cart"]', intent: 'add to cart button' };
const navCart: SelectorRecord = { level: 'css', arg: '[data-test="nav-cart"]', intent: 'cart link in header' };
const quantityInput: SelectorRecord = { level: 'label', arg: 'Quantity', intent: 'quantity input' };
const listingPrice: SelectorRecord = { level: 'css', arg: '[data-test="listing-price"]', intent: 'listing price' };
const priceCard: SelectorRecord = { level: 'css', arg: '[data-test="price-card"]', intent: 'price card' };
const unitPrice: SelectorRecord = { level: 'css', arg: '[data-test="unit-price"]', intent: 'detail price' };
// The cart page is revealed by an add (invariant 71) and is reached by these
// clicks from the shop page, never by its URL.
const REVEALED_PATH = '/checkout';

function scenarios(): Scenario[] {
  return [
    { name: 'listing shows a heading, at least one card, a price format and an image', category: 'happy', feature: 'catalogue', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'assert', name: 't', assertion: { type: 'toHaveText', target: pageTitle, text: 'Hand Tools', timeout: 5000 } },
      { kind: 'assert', name: 'c', assertion: { type: 'toHaveCount', target: cards, count: 1, atLeast: true, timeout: 5000 } },
      { kind: 'assert', name: 'p', assertion: { type: 'toHaveText', target: cardPrice, text: '', pattern: '^\\$\\d+\\.\\d{2}$', timeout: 5000 } },
      { kind: 'assert', name: 'i', assertion: { type: 'toHaveAttribute', target: cardImage, attribute: 'src', value: '', pattern: 'products/', timeout: 5000 } },
      { kind: 'assert', name: 'z', assertion: { type: 'toHaveCount', target: noSuch, count: 0, timeout: 5000 } },
      { kind: 'assert', name: 'pc', assertion: { type: 'toHaveCount', target: productCardsByPrefix, count: 1, atLeast: true, timeout: 5000 } },
    ] },
    { name: 'sorting by price high to low raises the first price', category: 'happy', feature: 'catalogue', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'capture', varName: 'cap_firstPrice', source: 'text', target: cardPrice, intent: 'first card price' },
      { kind: 'click', target: sortButton },
      { kind: 'assert_compare', varName: 'cap_firstPrice', relation: 'greater', source: 'text', target: cardPrice, intent: 'first card price', readVar: 'cap_firstPrice_now' },
    ] },
    { name: 'clicking a card opens its detail page with the same name', category: 'happy', feature: 'catalogue', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'capture', varName: 'cap_listingName', source: 'text', target: cardName, intent: 'first card name' },
      { kind: 'click', target: firstCard },
      // The model's URL timeout is recorded and emitted: expect(page).toHaveURL(pattern, { timeout }).
      { kind: 'assert', name: 'u', assertion: { type: 'toHaveURL', pattern: 'detail', timeout: 15000 } },
      { kind: 'assert_compare', varName: 'cap_listingName', relation: 'equal', source: 'text', target: cardName, intent: 'first card name', readVar: 'cap_listingName_now', readTarget: detailHeading },
    ] },
    { name: 'the token id regenerates on click', category: 'happy', feature: 'token', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'capture', varName: 'cap_oldId', source: 'attribute', attribute: 'id', target: regenButton, intent: 'regenerate button' },
      { kind: 'click', target: regenButton },
      { kind: 'assert_compare', varName: 'cap_oldId', relation: 'changed', source: 'attribute', attribute: 'id', target: regenButton, intent: 'regenerate button', readVar: 'cap_oldId_now' },
    ] },
    { name: 'contact form thanks the sender by name', category: 'happy', feature: 'contact', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'assert', name: 'h', assertion: { type: 'toHaveText', target: headingNoIntent, text: 'Hand Tools', timeout: 5000 } },
      { kind: 'assert', name: 's', assertion: { type: 'toBeVisible', target: sendNoIntent, timeout: 5000 } },
      { kind: 'fill', target: nameInput, value: 'Jane' },
      { kind: 'select_option', target: subjectSelect, by: 'value', option: 'warranty' },
      { kind: 'set_checked', target: ecoBox, checked: true },
      { kind: 'assert', name: 'k', assertion: { type: 'toBeChecked', target: ecoBox, checked: true, timeout: 5000 } },
      { kind: 'assert', name: 'v', assertion: { type: 'toHaveValue', target: nameInput, value: 'Jane', timeout: 5000 } },
      { kind: 'click', target: sendButton },
      { kind: 'assert', name: 'a', assertion: { type: 'toContainText', target: alertBox, text: 'Thanks for your message', timeout: 5000 } },
    ] },
    { name: 'the sample frame shows its heading', category: 'happy', feature: 'frames', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'assert', name: 'f', assertion: { type: 'toHaveText', target: frameHeading, text: 'Sample Heading', timeout: 5000 } },
    ] },
    { name: 'registering with a fresh email is welcomed', category: 'happy', feature: 'registration', steps: [
      { kind: 'navigate', url: `${base}/register.html` },
      { kind: 'fill', target: emailInput, value: 'qa.user.fixture@example.com', generate: 'email' },
      { kind: 'fill', target: passwordInput, value: 'Fixture-Pass-1', generate: 'password' },
      { kind: 'click', target: registerButton },
      { kind: 'assert', name: 'w', assertion: { type: 'toContainText', target: alertBox, text: 'Welcome', timeout: 5000 } },
    ] },
    // The registration feature now spans two first URLs (the form page and
    // the landing page), so the feature has no shared beforeEach goto and
    // each test opens its own recorded first URL (run 51d535: account spanned
    // /auth/register and /auth/login under one class url).
    // Capture readiness in the emitted spec (invariant 39): the list renders
    // 800 ms after load, so an immediate count() reads 0 and a less compare
    // against the filtered list can never hold. The emitted capture waits.
    { name: 'filtering the late-rendered list lowers the card count', category: 'happy', feature: 'delayed', steps: [
      { kind: 'navigate', url: `${base}/delayed.html` },
      { kind: 'capture', varName: 'cap_cardCount', source: 'count', target: delayedItems, intent: 'product cards' },
      { kind: 'click', target: filterButton },
      { kind: 'assert_compare', varName: 'cap_cardCount', relation: 'less', source: 'count', target: delayedItems, intent: 'product cards', readVar: 'cap_cardCount_now' },
    ] },
    // A legitimately empty baseline: the badge does not exist until the first
    // add. The grace waits, then reads 0, and greater still holds after the click.
    { name: 'adding to the cart creates the badge', category: 'happy', feature: 'delayed', steps: [
      { kind: 'navigate', url: `${base}/delayed.html` },
      { kind: 'capture', varName: 'cap_badgeCount', source: 'count', target: cartBadge, intent: 'cart badge' },
      { kind: 'click', target: addButton },
      { kind: 'assert_compare', varName: 'cap_badgeCount', relation: 'greater', source: 'count', target: cartBadge, intent: 'cart badge', readVar: 'cap_badgeCount_now' },
    ] },
    // A counter read by its text (gate RULE 7 refuses a literal count on it,
    // RULE 9 a count capture): the badge shows 1 after the first add, the
    // capture reads that text, the second add raises it, and the compare
    // polls through parseNumber.
    { name: 'a second add raises the number on the cart badge', category: 'happy', feature: 'delayed', steps: [
      { kind: 'navigate', url: `${base}/delayed.html` },
      { kind: 'click', target: addButton },
      { kind: 'capture', varName: 'cap_badgeText', source: 'text', target: cartBadge, intent: 'cart badge' },
      { kind: 'click', target: addButton },
      { kind: 'assert_compare', varName: 'cap_badgeText', relation: 'greater', source: 'text', target: cartBadge, intent: 'cart badge', readVar: 'cap_badgeText_now' },
    ] },
    // Reached by action (invariant 71): the origin rule is verified on the
    // shop page, the cart rule by clicking through to the revealed page.
    { name: 'adding a product from its page shows the cart link in the header', category: 'happy', feature: 'cart', steps: [
      { kind: 'navigate', url: `${base}/shop.html` },
      { kind: 'click', target: itemLink },
      { kind: 'click', target: addToCart },
      { kind: 'assert', name: 'cl', assertion: { type: 'toBeVisible', target: navCart, timeout: 10000 } },
    ] },
    { name: 'opening the cart from the header lists the added product with a quantity', category: 'happy', feature: 'cart', steps: [
      { kind: 'navigate', url: `${base}/shop.html` },
      { kind: 'click', target: itemLink },
      { kind: 'click', target: addToCart },
      { kind: 'click', target: navCart },
      { kind: 'assert', name: 'cu', assertion: { type: 'toHaveURL', pattern: 'checkout', timeout: 10000 } },
      { kind: 'assert', name: 'cq', assertion: { type: 'toHaveValue', target: quantityInput, value: '1', timeout: 10000 } },
    ] },
    // Run 59540f (D4): "$14.15" on the listing, "14.15" on the detail page.
    // The recorded equal compare passes in the emitted framework too.
    { name: 'the detail page shows the same price as the listing', category: 'edge', feature: 'prices', steps: [
      { kind: 'navigate', url: `${base}/price-list.html` },
      { kind: 'capture', varName: 'cap_listingPrice', source: 'text', target: listingPrice, intent: 'listing price' },
      { kind: 'click', target: priceCard },
      { kind: 'assert', name: 'pu', assertion: { type: 'toHaveURL', pattern: 'price-detail', timeout: 10000 } },
      { kind: 'assert_compare', varName: 'cap_listingPrice', relation: 'equal', source: 'text', target: listingPrice, intent: 'listing price', readVar: 'cap_listingPrice_now', readTarget: unitPrice },
    ] },
    // The shared sameValue table: a row whose two values are the same value
    // ships as equal, a row whose values differ ships as changed, and both
    // must pass, so each row's answer is executed in the shipped framework.
    ...SAME_VALUE_CASES.map((c, i): Scenario => ({
      name: `value row ${i + 1} compares as ${c.equal ? 'the same value' : 'different values'}`, category: 'edge', feature: 'prices', steps: [
        { kind: 'navigate', url: `${base}/values.html` },
        { kind: 'capture', varName: `cap_row${i + 1}`, source: 'text', target: { level: 'css', arg: `#cap-${i}`, intent: `row ${i + 1} captured value` }, intent: `row ${i + 1} captured value` },
        { kind: 'assert_compare', varName: `cap_row${i + 1}`, relation: c.equal ? 'equal' : 'changed', source: 'text', target: { level: 'css', arg: `#cap-${i}`, intent: `row ${i + 1} captured value` }, intent: `row ${i + 1} captured value`, readVar: `cap_row${i + 1}_now`, readTarget: { level: 'css', arg: `#now-${i}`, intent: `row ${i + 1} other value` } },
      ],
    })),
    { name: 'the create account link on the landing page opens the registration form', category: 'happy', feature: 'registration', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'click', target: createAccountLink },
      { kind: 'assert', name: 'u2', assertion: { type: 'toHaveURL', pattern: 'register', timeout: 5000 } },
      { kind: 'assert', name: 'e', assertion: { type: 'toBeVisible', target: emailInput, timeout: 5000 } },
    ] },
  ];
}

const SCENARIO_COUNT = scenarios().length;

const CART_REACHED_BY = {
  origin: `${base}/shop.html`,
  actions: [
    { kind: 'click' as const, via: 'item-link' as const },
    { kind: 'click' as const, control: 'getByTestId("add-to-cart")' },
    { kind: 'click' as const, control: 'getByTestId("nav-cart")' },
  ],
};

function buildReport(language: 'ts' | 'js'): RunReport {
  return {
    url: `${base}/`, language,
    // The run-report a reached-by-action run writes: the revealed page on the
    // discovery record and reachedBy on its plan entry. The emitters read the
    // recorded steps only, so neither changes what they write.
    discovery: {
      method: 'crawl',
      pages: [
        { url: `${base}/shop.html`, source: 'crawl', feature: 'cart' },
        { url: `${base}${REVEALED_PATH}`, source: 'action', feature: 'cart', reachedBy: { ...CART_REACHED_BY, feature: 'cart' } },
      ],
      warnings: [],
      stateProbes: [{ feature: 'cart', outcome: 'revealed', origins: [`${base}/shop.html`], tried: [], revealed: `${base}${REVEALED_PATH}`, detail: `revealed ${REVEALED_PATH} from /shop.html`, rulesSplit: [] }],
    },
    plan: [{ name: 'opening the cart from the header lists the added product with a quantity', category: 'happy', rationale: 'fixture', feature: 'cart', pageUrl: `${base}/shop.html`, reachedBy: { pageUrl: `${base}${REVEALED_PATH}`, origin: `${base}/shop.html`, actions: CART_REACHED_BY.actions } }],
    scenarios: scenarios(),
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    steps: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  };
}

/** Mixed attributes: one data-test step and one step recorded at level testid (Playwright's default data-testid). */
function buildMixedReport(language: 'ts' | 'js'): RunReport {
  return {
    url: `${base}/mixed.html`, language,
    scenarios: [{ name: 'clicking go shows done in the status', category: 'happy', feature: 'mixed', steps: [
      { kind: 'navigate', url: `${base}/mixed.html` },
      { kind: 'click', target: { level: 'css', arg: '[data-test="go"]', intent: 'go button' } },
      { kind: 'assert', name: 'st', assertion: { type: 'toHaveText', target: { level: 'testid', arg: 'status', intent: 'status text' }, text: 'Done', timeout: 5000 } },
    ] }],
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    steps: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  };
}

/** The lines of a file that name a test id, trimmed, for the lock's printed output. */
const testIdLines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter((l) => /testIdAttribute|getByTestId|data-test/.test(l));

/* ─── 3. install and run ────────────────────────────────────────────────── */

interface RunResult { status: number | null; stdout: string; stderr: string }

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); stderr += `\n(killed after ${timeoutMs}ms)`; }, timeoutMs);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

/** npm install: the local npm cache first (no network), the registry only when the cache cannot satisfy the pins. */
async function npmInstall(cwd: string): Promise<{ ok: boolean; mode: string; detail: string }> {
  const common = ['install', '--no-audit', '--no-fund', '--loglevel=error', '--ignore-scripts'];
  const offline = await run('npm', [...common, '--offline'], cwd, 300_000);
  if (offline.status === 0) return { ok: true, mode: 'npm cache (offline, no network)', detail: '' };
  const online = await run('npm', [...common, '--prefer-offline'], cwd, 600_000);
  if (online.status === 0) return { ok: true, mode: 'registry (network; the npm cache could not satisfy the pins)', detail: offline.stderr.trim().split('\n').slice(-2).join(' ') };
  return { ok: false, mode: 'failed', detail: (online.stderr || online.stdout).trim().split('\n').slice(-6).join('\n') };
}

interface PwJson { stats: { expected: number; unexpected: number; flaky: number; skipped: number }; suites: PwSuite[] }
interface PwSuite { file?: string; title: string; specs: Array<{ title: string; ok: boolean; tests: Array<{ status: string }> }>; suites?: PwSuite[] }

function flattenSpecs(suites: PwSuite[], file = ''): Array<{ file: string; title: string; ok: boolean; status: string }> {
  const out: Array<{ file: string; title: string; ok: boolean; status: string }> = [];
  for (const s of suites) {
    const f = s.file ?? file;
    for (const sp of s.specs ?? []) out.push({ file: f, title: sp.title, ok: sp.ok, status: sp.tests[0]?.status ?? 'missing' });
    if (s.suites) out.push(...flattenSpecs(s.suites, f));
  }
  return out;
}

const summaries: Record<string, string> = {};
const installModes: Record<string, string> = {};

for (const language of ['ts', 'js'] as const) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `qa-emitted-run-${language}-`));
  try {
    const report = buildReport(language);
    scaffold({ report, outDir, siteName: 'toolshop-fixture' });
    // Rule 2 (invariant 77, run 59540f D7b): no emitted file asserts an
    // empty text, and the old dataset fallback c.errorText ?? '' is gone.
    const emptyHits = emptyTextHits(readTree(outDir));
    check(`${language}: no file of the POM framework holds toContainText('') / toHaveText('') or toContainText(c.errorText ?? '')`, emptyHits.length === 0, emptyHits.join(' | '));
    const catalogueSpec = fs.readFileSync(path.join(outDir, `tests/catalogue/catalogue.spec.${language}`), 'utf8');
    check(`${language}: the emitted toHaveURL carries the recorded timeout`, /toHaveURL\(new RegExp\("detail"\), \{ timeout: 15000 \}\)/.test(catalogueSpec), catalogueSpec.split('\n').filter((l) => /toHaveURL/.test(l)).join(' | '));
    // Field identity: the two intent-less assertions on different locators
    // land in two fields named from the locators, and no field is "element".
    const contactPage = fs.readFileSync(path.join(outDir, `pages/contact-page.${language}`), 'utf8');
    const fieldDecl = (name: string): boolean => language === 'ts' ? contactPage.includes(`readonly ${name}: Locator;`) : contactPage.includes(`this.${name} = `);
    check(`${language}: two intent-less locators land in two fields (h1 and send), never one "element" field`, fieldDecl('h1') && fieldDecl('send') && !fieldDecl('element') && contactPage.includes('page.locator("h1")') && contactPage.includes('page.locator("#send")'), contactPage);
    const contactSpec = fs.readFileSync(path.join(outDir, `tests/contact/contact.spec.${language}`), 'utf8');
    check(`${language}: the contact spec asserts each through its own field`, /expect\(contactPage\.h1\)\.toHaveText\("Hand Tools"/.test(contactSpec) && /expect\(contactPage\.send\)\.toBeVisible/.test(contactSpec), contactSpec);
    // Multi-page feature: no beforeEach goto, one goto per test.
    const registrationSpec = fs.readFileSync(path.join(outDir, `tests/registration/registration.spec.${language}`), 'utf8');
    const beforeEach = registrationSpec.slice(registrationSpec.indexOf('test.beforeEach'), registrationSpec.indexOf('test("'));
    const gotos = (registrationSpec.match(/await page\.goto\(/g) ?? []).length;
    check(`${language}: a feature whose scenarios start on two URLs emits no beforeEach goto and a page.goto per test`, !/\.goto\(\)/.test(beforeEach) && /start on different pages/.test(beforeEach) && gotos === 2, `beforeEach=${beforeEach.trim()} gotos=${gotos}`);
    // Capture readiness (invariant 39): the count capture a compare reads is
    // preceded by the shipped awaitCaptureReady with replay's timeout, in
    // both the less case and the empty-baseline greater case.
    const delayedSpec = fs.readFileSync(path.join(outDir, `tests/delayed/delayed.spec.${language}`), 'utf8');
    const delayedLines = delayedSpec.split('\n').map((l) => l.trim());
    const waitBefore = (varName: string): boolean => {
      const i = delayedLines.findIndex((l) => l.startsWith(`const ${varName} = await `) && l.includes('.count();'));
      return i > 0 && /^await awaitCaptureReady\(page\.locator\(".+"\), 10000\);/.test(delayedLines[i - 1] ?? '');
    };
    check(`${language}: the emitted count captures wait for their target before the read (less and the empty-baseline greater)`, waitBefore('cap_cardCount') && waitBefore('cap_badgeCount'), delayedLines.filter((l) => /cap_cardCount|cap_badgeCount|awaitCaptureReady/.test(l)).join(' | '));
    const badgeTextLine = delayedLines.findIndex((l) => l.startsWith('const cap_badgeText = ') && l.includes('textContent()'));
    check(`${language}: the badge counter is read by its text (no wait, no count) and the greater compare polls through parseNumber`,
      badgeTextLine > 0 && !/awaitCaptureReady/.test(delayedLines[badgeTextLine - 1] ?? '') && delayedLines.some((l) => /^await expect\.poll\(async \(\) => parseNumber\(.*textContent\(\).*\), \{ timeout: \d+ \}\)\.toBeGreaterThan\(parseNumber\(cap_badgeText\)\);$/.test(l)),
      delayedLines.filter((l) => /cap_badgeText/.test(l)).join(' | '));
    const helperImport = language === 'ts' ? `import { awaitCaptureReady } from '../../helpers/assertions';` : `const { awaitCaptureReady } = require('../../helpers/assertions');`;
    check(`${language}: the delayed spec imports awaitCaptureReady from helpers/assertions and the helper is shipped`, delayedSpec.includes(helperImport) && fs.readFileSync(path.join(outDir, `helpers/assertions.${language}`), 'utf8').includes('async function awaitCaptureReady(locator'), delayedSpec.split('\n').slice(0, 6).join(' | '));
    const contactBeforeEach = contactSpec.slice(contactSpec.indexOf('test.beforeEach'), contactSpec.indexOf('test("'));
    check(`${language}: a feature whose scenarios share one first URL keeps the beforeEach goto`, /contactPage\.goto\(\)/.test(contactBeforeEach), contactBeforeEach);
    // Invariant 71: no emitted file opens the revealed page by its URL, POM
    // or single file. The tree is grepped for any goto line naming it and
    // for a page-object url set to it.
    const singleDir = fs.mkdtempSync(path.join(os.tmpdir(), `qa-emitted-single-${language}-`));
    try {
      const single = transcribe({ report, outDir: singleDir, name: 'cart-fixture' });
      const singleEmptyHits = emptyTextHits(readTree(singleDir));
      check(`${language}: no line of the single-file spec asserts an empty text`, singleEmptyHits.length === 0, singleEmptyHits.join(' | '));
      const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.name === 'node_modules' ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
      const emitted = [...walk(outDir).filter((f) => /\.(ts|js)$/.test(f)), single.specPath];
      const hits = emitted.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => (/\.goto\(/.test(l) || /\burl\s*=/.test(l)) && l.includes(REVEALED_PATH)).map((l) => `${path.basename(f)}: ${l.trim()}`));
      check(`${language}: no page.goto (or page-object url) on the revealed ${REVEALED_PATH} in the POM tree or the single-file spec: ${hits.length} hits`, hits.length === 0, hits.join(' | '));
      const cartSpec = fs.readFileSync(path.join(outDir, `tests/cart/cart.spec.${language}`), 'utf8');
      const singleSpec = fs.readFileSync(single.specPath, 'utf8');
      check(`${language}: the cart spec and the single-file spec reach the cart by the recorded clicks from the shop page`,
        /cartPage\.goto\(\)/.test(cartSpec) && /nav-cart/.test(fs.readFileSync(path.join(outDir, `pages/cart-page.${language}`), 'utf8')) && singleSpec.includes('/shop.html') && singleSpec.includes('nav-cart'), cartSpec);
    } finally {
      fs.rmSync(singleDir, { recursive: true, force: true });
    }
    // sameValue (invariant 76): the helper is shipped and the prices spec
    // polls every equal and changed compare through it.
    const pricesSpec = fs.readFileSync(path.join(outDir, `tests/prices/prices.spec.${language}`), 'utf8');
    const sameValueImport = language === 'ts' ? `import { sameValue } from '../../helpers/same-value';` : `const { sameValue } = require('../../helpers/same-value');`;
    const sameValuePolls = (pricesSpec.match(/return sameValue\(cap_\w+, now\) \? cap_\w+ : now; \}, \{ timeout: 10000 \}\)\.(?:not\.)?toBe\(cap_\w+\);/g) ?? []).length;
    check(`${language}: helpers/same-value is shipped, the prices spec imports it and polls all ${SAME_VALUE_CASES.length + 1} equal / changed compares through it`,
      fs.existsSync(path.join(outDir, `helpers/same-value.${language}`)) && fs.readFileSync(path.join(outDir, `helpers/same-value.${language}`), 'utf8').includes('function sameValue(captured') && pricesSpec.includes(sameValueImport) && sameValuePolls === SAME_VALUE_CASES.length + 1,
      `polls=${sameValuePolls} | ` + pricesSpec.split('\n').filter((l) => /sameValue/.test(l)).slice(0, 3).join(' | '));
    check(`${language}: scaffold wrote the config, a spec per feature and the a11y spec`,
      fs.existsSync(path.join(outDir, `playwright.config.${language}`))
      && fs.existsSync(path.join(outDir, `tests/catalogue/catalogue.spec.${language}`))
      && fs.existsSync(path.join(outDir, `tests/registration/registration.spec.${language}`))
      && fs.existsSync(path.join(outDir, `tests/a11y/landing.a11y.spec.${language}`))
      && fs.existsSync(path.join(outDir, `helpers/parse-number.${language}`)));

    // Test ids (invariant 73): every exact test-id selector in the main
    // fixture uses data-test, so the config sets the attribute and the page
    // objects call getByTestId; the prefix selector stays css.
    const config = fs.readFileSync(path.join(outDir, `playwright.config.${language}`), 'utf8');
    const cartPageText = fs.readFileSync(path.join(outDir, `pages/cart-page.${language}`), 'utf8');
    const cataloguePageText = fs.readFileSync(path.join(outDir, `pages/catalogue-page.${language}`), 'utf8');
    console.log(`  ${language} test-id lock (all data-test): playwright.config: ${testIdLines(config).join(' | ') || '(no test-id line)'}`);
    console.log(`  ${language} test-id lock (all data-test): pages/cart-page: ${testIdLines(cartPageText).join(' | ')}`);
    console.log(`  ${language} test-id lock (all data-test): pages/catalogue-page: ${testIdLines(cataloguePageText).join(' | ')}`);
    check(`${language}: an all-data-test recording sets testIdAttribute: 'data-test' in the config use block`, /use: \{[^}]*testIdAttribute: 'data-test',/.test(config), config);
    check(`${language}: the add-to-cart button is emitted as getByTestId("add-to-cart"), never the data-test css`, cartPageText.includes('page.getByTestId("add-to-cart")') && !cartPageText.includes('[data-test=\\"add-to-cart\\"]'), cartPageText);
    check(`${language}: the page title and the absent banner are emitted as getByTestId`, cataloguePageText.includes('page.getByTestId("page-title")') && cataloguePageText.includes('page.getByTestId("no-such")'), cataloguePageText);
    check(`${language}: the prefix selector a[data-test^="product-"] stays css`, cataloguePageText.includes('page.locator("a[data-test^=\\"product-\\"]")') && !/getByTestId\("product-/.test(cataloguePageText), cataloguePageText);

    const install = await npmInstall(outDir);
    installModes[language] = install.mode;
    check(`${language}: npm install succeeded via ${install.mode}`, install.ok, install.detail);
    if (!install.ok) continue;
    check(`${language}: the framework's own @playwright/test resolved`, fs.existsSync(path.join(outDir, 'node_modules/@playwright/test/package.json')));

    // Playwright's own exit code is the first gate; the JSON report the second.
    const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: 'results.json' } as NodeJS.ProcessEnv;
    delete env.CI;
    const pw = await run('npx', ['playwright', 'test', '--reporter=list,json'], outDir, 600_000, env);
    const summary = pw.stdout.split('\n').map((l) => l.trim()).filter((l) => /^\d+ (passed|failed|flaky|skipped)/.test(l)).join(' · ');
    summaries[language] = summary || '(no summary line)';
    console.log(`${language}: playwright exit ${String(pw.status)}: ${summaries[language]}`);
    check(`${language}: npx playwright test exited 0`, pw.status === 0, (pw.stdout + '\n' + pw.stderr).trim().split('\n').slice(-25).join('\n'));

    const jsonPath = path.join(outDir, 'results.json');
    check(`${language}: the JSON report was written`, fs.existsSync(jsonPath));
    if (!fs.existsSync(jsonPath)) continue;
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as PwJson;
    const specs = flattenSpecs(json.suites);
    const a11y = specs.filter((s) => /a11y[\\/]landing\.a11y\.spec/.test(s.file));
    check(`${language}: zero unexpected and zero flaky results in the JSON report`, json.stats.unexpected === 0 && json.stats.flaky === 0, JSON.stringify(json.stats));
    check(`${language}: every scenario plus the a11y check passed (${SCENARIO_COUNT + 1} expected)`, json.stats.expected === SCENARIO_COUNT + 1 && json.stats.skipped === 0, JSON.stringify({ stats: json.stats, specs: specs.map((s) => `${s.status}:${s.title}`) }));
    check(`${language}: the a11y spec ran and passed`, a11y.length === 1 && a11y[0]!.ok && a11y[0]!.status === 'expected', JSON.stringify(a11y));
    check(`${language}: no spec is reported as failed`, specs.every((s) => s.ok && s.status === 'expected'), specs.filter((s) => !s.ok).map((s) => `${s.file}: ${s.title}`).join(' | '));
    const priceSpecs = specs.filter((s) => /prices[\\/]prices\.spec/.test(s.file));
    check(`${language}: the run 59540f price pair and all ${SAME_VALUE_CASES.length} sameValue rows executed and passed (${SAME_VALUE_CASES.length + 1} tests)`, priceSpecs.length === SAME_VALUE_CASES.length + 1 && priceSpecs.every((s) => s.ok && s.status === 'expected'), JSON.stringify(priceSpecs.map((s) => `${s.status}:${s.title}`)));

    // Mixed attributes (invariant 73): one data-test step, one data-testid
    // step. No testIdAttribute, the data-test selector stays css, the testid
    // step keeps the default getByTestId, and the framework runs green.
    // node_modules is the main framework's, linked in.
    const mixedDir = fs.mkdtempSync(path.join(os.tmpdir(), `qa-emitted-mixed-${language}-`));
    const singleRunDir = fs.mkdtempSync(path.join(os.tmpdir(), `qa-emitted-single-run-${language}-`));
    try {
      scaffold({ report: buildMixedReport(language), outDir: mixedDir, siteName: 'mixed-fixture' });
      const mixedEmptyHits = emptyTextHits(readTree(mixedDir));
      check(`${language}: no file of the mixed framework asserts an empty text`, mixedEmptyHits.length === 0, mixedEmptyHits.join(' | '));
      const mixedConfig = fs.readFileSync(path.join(mixedDir, `playwright.config.${language}`), 'utf8');
      const mixedPage = fs.readFileSync(path.join(mixedDir, `pages/mixed-page.${language}`), 'utf8');
      console.log(`  ${language} test-id lock (mixed): playwright.config: ${testIdLines(mixedConfig).join(' | ') || '(no test-id line)'}`);
      console.log(`  ${language} test-id lock (mixed): pages/mixed-page: ${testIdLines(mixedPage).join(' | ')}`);
      check(`${language}: a mixed recording emits no testIdAttribute`, !mixedConfig.includes('testIdAttribute'), mixedConfig);
      check(`${language}: a mixed recording keeps the data-test css and the default getByTestId`, mixedPage.includes('page.locator("[data-test=\\"go\\"]")') && mixedPage.includes('page.getByTestId("status")'), mixedPage);
      fs.symlinkSync(path.join(outDir, 'node_modules'), path.join(mixedDir, 'node_modules'), 'dir');
      const mixedEnv = { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: 'results.json' } as NodeJS.ProcessEnv;
      const mixedRun = await run('npx', ['playwright', 'test', '--reporter=list,json'], mixedDir, 300_000, mixedEnv);
      const mixedJson = fs.existsSync(path.join(mixedDir, 'results.json')) ? JSON.parse(fs.readFileSync(path.join(mixedDir, 'results.json'), 'utf8')) as PwJson : null;
      console.log(`${language} mixed: playwright exit ${String(mixedRun.status)}: ${mixedJson ? JSON.stringify(mixedJson.stats) : '(no JSON report)'}`);
      check(`${language}: the mixed framework runs green (the scenario and the a11y spec)`, mixedRun.status === 0 && mixedJson !== null && mixedJson.stats.expected === 2 && mixedJson.stats.unexpected === 0, (mixedRun.stdout + '\n' + mixedRun.stderr).trim().split('\n').slice(-25).join('\n'));

      // The single-file spec of the all-data-test report sets the attribute
      // with test.use and runs green with no config file.
      const singleRun = transcribe({ report, outDir: singleRunDir, name: 'toolshop-fixture' });
      const singleText = fs.readFileSync(singleRun.specPath, 'utf8');
      console.log(`  ${language} test-id lock (single file): ${testIdLines(singleText).filter((l) => /testIdAttribute|add-to-cart|page-title/.test(l)).join(' | ')}`);
      check(`${language}: the single-file spec sets test.use({ testIdAttribute: "data-test" }) and calls getByTestId`, singleText.includes('test.use({ testIdAttribute: "data-test" });') && singleText.includes('getByTestId("add-to-cart")'), singleText.split('\n').slice(0, 30).join('\n'));
      fs.symlinkSync(path.join(outDir, 'node_modules'), path.join(singleRunDir, 'node_modules'), 'dir');
      const singleRes = await run('npx', ['playwright', 'test', '--reporter=list,json'], singleRunDir, 600_000, mixedEnv);
      const singleJson = fs.existsSync(path.join(singleRunDir, 'results.json')) ? JSON.parse(fs.readFileSync(path.join(singleRunDir, 'results.json'), 'utf8')) as PwJson : null;
      console.log(`${language} single file: playwright exit ${String(singleRes.status)}: ${singleJson ? JSON.stringify(singleJson.stats) : '(no JSON report)'}`);
      check(`${language}: the single-file spec runs green with no config file`, singleRes.status === 0 && singleJson !== null && singleJson.stats.unexpected === 0 && singleJson.stats.flaky === 0, (singleRes.stdout + '\n' + singleRes.stderr).trim().split('\n').slice(-25).join('\n'));
      const singleSpecs = singleJson ? flattenSpecs(singleJson.suites) : [];
      const singleValueSpecs = singleSpecs.filter((sp) => /value row \d+ compares as|same price as the listing/.test(sp.title));
      check(`${language}: the single-file spec inlines sameValue and its ${SAME_VALUE_CASES.length + 1} price and value tests passed`, /^function sameValue\(captured, current\)/m.test(singleText) && singleValueSpecs.length === SAME_VALUE_CASES.length + 1 && singleValueSpecs.every((sp) => sp.ok && sp.status === 'expected'), JSON.stringify(singleValueSpecs.map((sp) => `${sp.status}:${sp.title}`)));
    } finally {
      fs.rmSync(mixedDir, { recursive: true, force: true });
      fs.rmSync(singleRunDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

server.close();

console.log(`\ninstall: ts via ${installModes.ts ?? 'n/a'}; js via ${installModes.js ?? 'n/a'}`);
console.log(`playwright: ts ${summaries.ts ?? 'n/a'}; js ${summaries.js ?? 'n/a'}`);
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the emitted framework runs green in TypeScript and JavaScript against a served fixture site, every shape included, and the a11y spec runs.');
