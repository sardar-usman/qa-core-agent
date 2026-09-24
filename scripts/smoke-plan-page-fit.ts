/**
 * Locks the plan-time page-fit pass, the cross-page dedup and the feature
 * reachability line (src/agent/planner.ts), plus the `page-fit` derivation
 * skip reason (src/agent/rule-coverage.ts).
 *
 * Run 591732 wasted 7 of 20 plan slots: three registration scenarios on the
 * one-field password-reset form, the same login planned on two pages and
 * renamed "(page 2)", and four rentals scenarios asserting a price on cards
 * that carry none. Each fixture below is the live shape of that page.
 *
 *   - a password-reset snapshot rejects a "first name" and a "password"
 *     registration scenario and keeps a "rejected an unknown email" one
 *   - a rentals-shaped snapshot with no price text rejects a "price" scenario
 *     and keeps a "name and image" one
 *   - a hand-tools snapshot keeps a sort, a price, a filter and a pagination
 *     scenario
 *   - matching is on normalized words with synonyms, never exact strings
 *   - a cross-page duplicate login collapses to one, on the feature's page
 *   - the funnel identity holds after the drops
 *   - the derivation report names a page-fit drop as `page-fit`
 *   - an SRS feature with rules and no page prints its one line
 *
 *   - a navigation scenario (clicked, opened, landed, ...) is judged only on
 *     its first action's controls, never on the price it reads after
 *   - the whole-document flags are computed in the browser over the full
 *     page, so a price past the text sample and a search box past the
 *     inputs cap still count
 *
 * In-code fixtures plus one local page in headless Chromium for the flags.
 * No network. No LLM.
 */
import { chromium } from 'playwright';
import {
  pageFitReason,
  rejectPageFit,
  normalizeWords,
  dedupeAcrossPages,
  uniqueScenarioNames,
  unreachableFeatures,
  unreachableFeatureLine,
  snapshotPage,
  NAV_VERB_RE,
  TOP_TEXT_SAMPLE_CHARS,
  type PageFitSnapshot,
  type PlannedScenario,
} from '../src/agent/planner.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { computeDerivation } from '../src/agent/rule-coverage.js';
import { reconcile } from '../src/agent/reconcile.js';
import type { RequirementsMap } from '../src/agent/requirements.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

const sc = (name: string, category: PlannedScenario['category'] = 'happy', feature = 'registration', pageUrl?: string): PlannedScenario =>
  ({ name, category, feature, rationale: 'fails if the behavior breaks', ...(pageUrl ? { pageUrl } : {}) });

/* ─── fixtures: the live shapes of the run 591732 pages ───────────────────── */
const nav = [
  { tag: 'button', label: 'Testing Guide', type: 'submit' },
  { tag: 'button', label: 'Toggle navigation', type: 'button' },
  { tag: 'button', label: 'Categories', type: 'button' },
  { tag: 'button', label: 'Select language', type: 'button' },
];
const forgotPassword: PageFitSnapshot = {
  headings: [{ tag: 'h1', label: 'Forgot Password' }],
  inputs: [{ tag: 'input', label: 'Your email', type: 'email' }, { tag: 'input', type: 'submit' }],
  buttons: nav,
  textSample: 'View the Documentation for this application. Home Categories Contact Sign in EN Forgot Password Email address * LEARN & EXPLORE This is a DEMO application | Privacy Policy',
  tableHeaders: [],
  frames: [],
};
const rentals: PageFitSnapshot = {
  headings: [{ tag: 'h1', label: 'Rentals' }],
  inputs: [],
  buttons: nav,
  textSample: 'Home Categories Contact Sign in EN Rentals Excavator Heavy-duty tracked excavator available for hourly rental, designed for professional foundation digging. Bulldozer Robust tracked bulldozer available for hourly rental. Crane Mobile hydraulic crane available for hourly rental.',
  tableHeaders: [],
  frames: [],
};
const handTools: PageFitSnapshot = {
  headings: [{ tag: 'h2', label: 'Category: Hand Tools' }],
  inputs: [
    { tag: 'select', label: 'Name (A - Z)Name (Z - A)Price (High - Low)Price (Low - High)CO₂ Rating (A - E)CO', type: 'select-one' },
    ...Array.from({ length: 8 }, () => ({ tag: 'input', label: 'category_id', type: 'checkbox' })),
    ...Array.from({ length: 5 }, () => ({ tag: 'input', label: 'brand_id', type: 'checkbox' })),
    { tag: 'input', label: 'eco_friendly', type: 'checkbox' },
  ],
  buttons: [...nav, { tag: 'a', role: 'button', label: 'Filters', type: '' }, { tag: 'button', label: 'Compare', type: 'submit' }, { tag: 'a', role: 'button', label: 'Next', type: '' }],
  textSample: 'Home Categories Contact Sign in EN Category: Hand Tools Sort Name (A - Z) Name (Z - A) Price (High - Low) Price (Low - High) Filters By category: Hand Tools Hammer By brand: ForgeFlex Tools Sustainability: Show only eco-friendly products Combination Pliers A B C D E $14.15 Pliers $12.01',
  tableHeaders: [],
  frames: [],
};
// A reactive-form contact page: no name attributes, the field names live in
// <label for> text and ids only.
const contact: PageFitSnapshot = {
  headings: [{ tag: 'h1', label: 'Contact' }],
  inputs: [
    { tag: 'input', type: 'text', id: 'first_name', labelText: 'First name' },
    { tag: 'input', type: 'text', id: 'last_name', labelText: 'Last name' },
    { tag: 'input', type: 'text', id: 'email', labelText: 'Email address' },
    { tag: 'select', type: 'select-one', id: 'subject', label: 'Webmaster Customer service Return Payments Warranty', labelText: 'Subject' },
    { tag: 'textarea', type: 'textarea', id: 'message', labelText: 'Message' },
    { tag: 'input', type: 'file', id: 'attachment', labelText: 'Attachment' },
  ],
  buttons: [...nav, { tag: 'input', label: 'Send', type: 'submit' }],
  textSample: 'Home Categories Contact Sign in EN Contact First name Last name Email address Subject Message Attachment Send',
  tableHeaders: [],
  frames: [],
};
// A sortable table with no "sort" word anywhere: the headers are the control.
const table: PageFitSnapshot = {
  headings: [{ tag: 'h3', label: 'Data Tables' }],
  inputs: [],
  buttons: [],
  textSample: 'Data Tables Last Name First Name Email Due Web Site Action Smith John jsmith@gmail.com $50.00 http://www.jsmith.com edit delete',
  tableHeaders: ['Last Name', 'First Name', 'Email', 'Due', 'Web Site', 'Action'],
  frames: [],
};

/* ─── A. the password-reset page ──────────────────────────────────────────── */
const a1 = pageFitReason(sc('rejected registration with first name field left empty', 'negative'), forgotPassword);
check('A1. a "first name" registration scenario is rejected on the one-field reset form', a1?.control === 'first name', JSON.stringify(a1));
check('A2. the reason names the control and the missing evidence', a1?.reason === 'names first name which the page snapshot does not show', a1?.reason);
const a3 = pageFitReason(sc('created a new account with a valid email and password'), forgotPassword);
check('A3. a "password" scenario is rejected: the "Forgot Password" heading is not a password field', a3?.control === 'password', JSON.stringify(a3));
check('A4. a "rejected an unknown email" scenario is kept (the email field is there)',
  pageFitReason(sc('rejected an unknown email address and showed an error message', 'negative'), forgotPassword) === null);
check('A5. "error message" is an outcome, not a message field, so it needs no textarea',
  pageFitReason(sc('showed an error message when the email was empty', 'negative'), forgotPassword) === null);
check('A6. a scenario that names no control is never judged',
  pageFitReason(sc('rejected registration when a required field was left empty', 'negative'), forgotPassword) === null);

/* ─── B. the rentals page: cards with a name, an image, no price ──────────── */
const b1 = pageFitReason(sc('loaded the rentals page and saw products with name, image, and price', 'happy', 'catalogue'), rentals);
check('B1. a "price" scenario is rejected on a listing whose cards carry no price', b1?.control === 'price', JSON.stringify(b1));
check('B2. a "name and image" scenario is kept',
  pageFitReason(sc('loaded the rentals page and saw products with a name and image', 'happy', 'catalogue'), rentals) === null);
check('B3. a search scenario is rejected (no search box on the page)',
  pageFitReason(sc('searched for a term and saw only matching products in results', 'happy', 'catalogue'), rentals)?.control === 'search');
check('B4. a sort scenario is rejected (no sort control on the page)',
  pageFitReason(sc('sorted by price low to high and products reordered by ascending cost', 'happy', 'catalogue'), rentals)?.control === 'sort');
check('B5. a navigation scenario is not judged on the price it reads after the click: KEPT on the rentals listing',
  pageFitReason(sc('clicked a product and landed on its detail page showing matching name and price', 'edge', 'catalogue'), rentals) === null);
check('B6. the same price asserted on the listing itself is still dropped',
  pageFitReason(sc('loaded the rentals page and saw products with a price', 'happy', 'catalogue'), rentals)?.control === 'price');
check('B7. a navigation scenario is still judged on its first action when the name says so: "clicked the sort dropdown" needs a sort control',
  pageFitReason(sc('clicked the sort dropdown and the detail page opened in price order', 'happy', 'catalogue'), rentals)?.control === 'sort');
check('B8. every listed navigation verb triggers the exemption',
  ['clicked', 'click', 'opens', 'opened', 'landed', 'lands', 'navigates', 'navigated', 'goes to', 'detail page'].every((v) => NAV_VERB_RE.test(normalizeWords(`user ${v} the item and saw the price`)))
  && !NAV_VERB_RE.test(normalizeWords('loaded the rentals page and saw a price')));

/* ─── C. the hand-tools listing: sort select, checkboxes, prices, pages ────── */
check('C1. a sort scenario is kept (the Sort label and the select are there)',
  pageFitReason(sc('sorted products by price low to high and the list reordered in ascending price order', 'happy', 'catalogue'), handTools) === null);
check('C2. a price scenario is kept (the cards show $ amounts)',
  pageFitReason(sc("captured the first product's price, sorted by price low to high, the first product's price was lower than before", 'edge', 'catalogue'), handTools) === null);
check('C3. a checkbox filter scenario is kept',
  pageFitReason(sc('filtered by eco-friendly checkbox and only products marked eco-friendly remained visible', 'happy', 'catalogue'), handTools) === null);
check('C4. a pagination scenario is kept (Next button)',
  pageFitReason(sc('went to the next page and the product cards changed', 'happy', 'catalogue'), handTools) === null);
check('C5. a search scenario is rejected on the category page (the search box is on the home page)',
  pageFitReason(sc('searched for hammer and only matching products remained', 'happy', 'catalogue'), handTools)?.control === 'search');
// Price evidence must survive the normalizer: the currency symbol is read
// from the raw text.
const noPriceWord: PageFitSnapshot = { ...handTools, inputs: [], buttons: nav, textSample: 'Combination Pliers $14.15 Pliers $12.01' };
check('C6. a "$14.15" in the raw text evidences a price with no "price" word anywhere',
  pageFitReason(sc('saw a price on every card', 'happy', 'catalogue'), noPriceWord) === null);

/* ─── C2. whole-document flags, read in the browser over the full page ─────── */
// A listing whose first 3000 characters are nav and filter text and whose
// first price sits after them. The text sample (2000 chars) never reaches
// the price; the flag computed over the whole document does.
{
  const filterWords = Array.from({ length: 120 }, (_, i) => `<label><input type="checkbox" name="brand_${i}"> Brand number ${i} tools</label>`).join('\n');
  const html = `<!doctype html><html><body>
    <nav>Home Categories Contact Sign in EN</nav>
    <h2>Category: Hand Tools</h2>
    <aside><h3>Filters</h3>${filterWords}</aside>
    <main>
      <a class="card" href="/product/1"><h5>Combination Pliers</h5><span data-test="product-price">$14.15</span></a>
      <a class="card" href="/product/2"><h5>Pliers</h5><span data-test="product-price">$12.01</span></a>
    </main>
  </body></html>`;
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    await installEvalShim(ctx);
    const page = await ctx.newPage();
    await page.setContent(html);
    const snap = await snapshotPage(page);
    check('C7. the fixture is real: the text sample is capped and holds no price, the inputs list is capped',
      snap.textSample.length === TOP_TEXT_SAMPLE_CHARS && !/\$\d/.test(snap.textSample) && snap.inputs.length === 25, `sample ${snap.textSample.length} chars, inputs ${snap.inputs.length}`);
    check('C8. hasPrice is computed over the whole document', snap.flags.hasPrice === true, JSON.stringify(snap.flags));
    check('C9. hasFilter is true (checkboxes) and hasSort, hasSearch, hasPagination are false on this fixture',
      snap.flags.hasFilter === true && snap.flags.hasSort === false && snap.flags.hasSearch === false && snap.flags.hasPagination === false, JSON.stringify(snap.flags));
    check('C10. a price scenario is KEPT on that page', pageFitReason(sc('saw a price on every product card', 'happy', 'catalogue'), snap) === null);
    check('C11. a sort scenario is still dropped on that page (no sort control anywhere in the document)',
      pageFitReason(sc('sorted the products by price', 'happy', 'catalogue'), snap)?.control === 'sort');
    // The same page with a search box past the inputs cap: the flag sees it.
    await page.setContent(html.replace('</main>', '<input id="search" placeholder="Search products"></main>'));
    const withSearch = await snapshotPage(page);
    check('C12. hasSearch sees a search box past the 25-input cap', withSearch.flags.hasSearch === true && withSearch.inputs.length === 25, JSON.stringify(withSearch.flags));
    check('C13. a search scenario is kept on that page', pageFitReason(sc('searched for pliers and only matching cards stayed', 'happy', 'catalogue'), withSearch) === null);
  } finally {
    await browser.close();
  }
}

/* ─── D. matching is on normalized words with synonyms ────────────────────── */
check('D1. normalizeWords splits camelCase and snake_case: firstName / first_name / First-Name -> first name',
  normalizeWords('firstName') === 'first name' && normalizeWords('first_name') === 'first name' && normalizeWords('First-Name') === 'first name');
check('D2. the full contact scenario is kept on a reactive form whose fields have only <label for> text and ids',
  pageFitReason(sc('submitted contact form with valid first name, last name, email containing @, subject selection, and message', 'happy', 'contact'), contact) === null);
check('D3. a "given name" scenario is evidenced by a first_name id (synonym on the name side)',
  pageFitReason(sc('rejected an empty given name', 'negative', 'contact'), contact) === null);
check('D4. a "surname" scenario is evidenced by a Last name label (synonym on the name side)',
  pageFitReason(sc('rejected an empty surname', 'negative', 'contact'), contact) === null);
check('D5. a "file upload" scenario is evidenced by a type=file input',
  pageFitReason(sc('uploaded a file and saw its name listed', 'happy', 'contact'), contact) === null);
check('D6. "email address" is not a street address: an address scenario is rejected on the contact form',
  pageFitReason(sc('rejected an empty street address', 'negative', 'contact'), contact)?.control === 'address');
check('D7. a table with column headers evidences a sort control even with no "sort" word on the page',
  pageFitReason(sc('sorted the table by last name and the first row changed', 'happy', 'tables'), table) === null);
check('D8. a search scenario on that table page is still rejected (no search box)',
  pageFitReason(sc('searched the table and only matching rows stayed', 'happy', 'tables'), table)?.control === 'search');
// A snapshot whose inputs list hit its cap may hide a field past it; the
// pass then reads the whole page rather than judging on 25 controls.
const capped: PageFitSnapshot = {
  ...contact,
  inputs: Array.from({ length: 25 }, (_, i) => ({ tag: 'input', type: 'text', id: `field_${i}` })),
  textSample: 'A long form. Company name Country City Postcode Phone number',
};
check('D9. with the inputs list at its cap, a field named only in the page text is accepted',
  pageFitReason(sc('rejected an empty company', 'negative', 'contact'), capped) === null);

/* ─── E. rejectPageFit keeps order and reports each drop ──────────────────── */
const plan: PlannedScenario[] = [
  sc('created a new account with a valid email and password'),
  sc('rejected registration when the email address was already in use', 'negative'),
  sc('rejected registration with first name field left empty', 'negative'),
  sc('rejected registration when a required field was left empty', 'negative'),
];
const fit = rejectPageFit(plan, forgotPassword);
check('E1. two of the four registration scenarios are rejected on the reset form', fit.rejected.length === 2 && fit.kept.length === 2, JSON.stringify(fit.rejected.map((r) => r.control)));
check('E2. the rejected entries name password and first name', fit.rejected.map((r) => r.control).join(',') === 'password,first name');
check('E3. kept preserves plan order', fit.kept[0]?.name.includes('already in use') === true && fit.kept[1]?.name.includes('required field') === true);

/* ─── F. cross-page dedup ─────────────────────────────────────────────────── */
const loginUrl = 'https://s.example/auth/login';
const entryUrl = 'https://s.example/';
const catalogueUrl = 'https://s.example/category/hand-tools';
const pageFeature = (map: Record<string, string | undefined>) => (url: string | undefined): string | undefined => (url ? map[url] : undefined);
{
  // Run 591732: both pages tagged login; the login page came first.
  const first = [sc('logged in with valid credentials', 'happy', 'login', loginUrl)];
  const second = [sc('logged in with valid credentials', 'happy', 'login', entryUrl), sc('rejected login with a wrong password', 'negative', 'login', entryUrl)];
  const r = dedupeAcrossPages(first, second, { url: entryUrl, feature: 'login' }, pageFeature({ [loginUrl]: 'login', [entryUrl]: 'login' }));
  check('F1. the same login planned on a second page collapses: one dropped, the first-in-ladder-order copy kept',
    r.dropped.length === 1 && r.dropped[0]?.scenario.pageUrl === entryUrl && r.existing.length === 1 && r.existing[0]?.pageUrl === loginUrl, JSON.stringify(r));
  check('F2. a scenario with a different intent on the second page survives', r.incoming.length === 1 && r.incoming[0]?.name.includes('wrong password') === true);
  check('F3. the drop names the kept scenario', r.dropped[0]?.duplicateOf.pageUrl === loginUrl);
}
{
  // The feature's own page wins even when it comes second in ladder order.
  const first = [sc('logged in with valid credentials', 'happy', 'login', catalogueUrl)];
  const second = [sc('logged in with valid credentials', 'happy', 'login', loginUrl)];
  const r = dedupeAcrossPages(first, second, { url: loginUrl, feature: 'login' }, pageFeature({ [catalogueUrl]: 'catalogue', [loginUrl]: 'login' }));
  check('F4. the copy on the page tagged for the feature wins over an earlier copy on another feature\'s page',
    r.dropped.length === 1 && r.dropped[0]?.scenario.pageUrl === catalogueUrl && r.existing.length === 0 && r.incoming[0]?.pageUrl === loginUrl, JSON.stringify(r));
}
{
  // A shared name with a different category or feature is not a duplicate;
  // it still goes through the rename so the funnel keys stay unique.
  const first = [sc('rejected wrong password and stayed on login page', 'negative', 'login', loginUrl)];
  const second = [sc('rejected wrong password and stayed on login page', 'negative', 'registration', 'https://s.example/auth/register')];
  const r = dedupeAcrossPages(first, second, { url: 'https://s.example/auth/register', feature: 'registration' }, pageFeature({ [loginUrl]: 'login' }));
  check('F5. the same name under a different feature is not a cross-page duplicate', r.dropped.length === 0 && r.existing.length === 1 && r.incoming.length === 1);
  const renamed = uniqueScenarioNames(r.existing, r.incoming, { url: 'https://s.example/auth/register', feature: 'registration' });
  check('F6. that genuinely different scenario keeps the rename path', renamed.renames.length === 1 && renamed.scenarios[0]?.name === 'rejected wrong password and stayed on login page (registration)', JSON.stringify(renamed));
  const byCategory = dedupeAcrossPages(first, [sc('rejected wrong password and stayed on login page', 'edge', 'login', entryUrl)], { url: entryUrl, feature: 'login' }, pageFeature({ [loginUrl]: 'login', [entryUrl]: 'login' }));
  check('F7. the same name under a different category is not a cross-page duplicate', byCategory.dropped.length === 0);
}

/* ─── G. the funnel identity holds after the drops ────────────────────────── */
{
  const kept = [...fit.kept, sc('logged in with valid credentials', 'happy', 'login', loginUrl)];
  const report = {
    url: 'https://s.example/',
    scenarios: [],
    plan: kept,
    incomplete: kept.map((s) => ({ scenario: s.name, reason: 'never explored' })),
  } as unknown as Parameters<typeof reconcile>[0];
  const rec = reconcile(report);
  check('G1. planned counts only the kept scenarios and the funnel balances', rec.planned === kept.length && rec.balanced && rec.incomplete.length === kept.length, JSON.stringify({ planned: rec.planned, balanced: rec.balanced }));
}

/* ─── H. the derivation report names a page-fit drop ──────────────────────── */
const map: RequirementsMap = {
  features: [
    { name: 'registration', description: 'create an account', rules: [
      { id: 'R11', text: 'An email already in use is rejected with an error.', type: 'validation' },
      { id: 'R12', text: 'First name, last name, email and password are required.', type: 'validation' },
    ] },
    { name: 'cart', description: 'the shopping cart', rules: [
      { id: 'R6', text: 'Adding a product puts it in the cart.', type: 'behavior' },
      { id: 'R7', text: 'The quantity can be updated.', type: 'behavior' },
      { id: 'R8', text: 'An item can be removed.', type: 'behavior' },
      { id: 'R9', text: 'The total equals the sum of line prices.', type: 'behavior' },
    ] },
    { name: 'catalogue', description: 'browse products', rules: [{ id: 'R1', text: 'Products are listed with a name.', type: 'behavior' }] },
    { name: 'about', description: 'static page', rules: [] },
  ],
  roles: [],
  truncated: false,
};
{
  const planned = [{ ...sc('rejected registration when the email address was already in use', 'negative'), ruleIds: ['R11'] }];
  const rejected = fit.rejected.map((r) => r.scenario);
  const withFit = computeDerivation({ map, planned, budgetHit: false, pageFitRejected: rejected });
  const reg = withFit.find((d) => d.feature === 'registration');
  check('H1. required-omission skips as page-fit when the page-fit pass dropped the scenario that filled it',
    reg?.skipped.some((s) => s.category === 'required-omission' && s.reason === 'page-fit') === true, JSON.stringify(reg?.skipped));
  const without = computeDerivation({ map, planned, budgetHit: false });
  check('H2. without a page-fit drop the same skip reads no-matching-control',
    without.find((d) => d.feature === 'registration')?.skipped.some((s) => s.category === 'required-omission' && s.reason === 'no-matching-control') === true);
  check('H3. a not-applicable category stays not-applicable', reg?.skipped.some((s) => s.category === 'state-transition' && s.reason === 'not-applicable') === true, JSON.stringify(reg?.skipped));
}

/* ─── I. feature reachability ─────────────────────────────────────────────── */
{
  const pages = [{ url: catalogueUrl, feature: 'catalogue' }, { url: loginUrl, feature: 'login' }, { url: 'https://s.example/auth/register', feature: 'registration' }];
  const unreachable = unreachableFeatures(map, pages);
  check('I1. cart (4 rules, no page) is the one unreachable feature; a feature with no rules is not listed',
    unreachable.length === 1 && unreachable[0]?.name === 'cart' && unreachable[0]?.rules === 4, JSON.stringify(unreachable));
  check('I2. the line reads exactly as specified',
    unreachableFeatureLine(unreachable[0]!) === 'Feature "cart" has 4 rules and no discovered page; its rules will report not-planned', unreachableFeatureLine(unreachable[0]!));
  check('I3. without a map nothing is reported', unreachableFeatures(undefined, pages).length === 0);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: page-fit drops a scenario that names a control the snapshot does not show, cross-page duplicates collapse to one, the funnel balances after the drops, derivation says page-fit, and an unreachable SRS feature prints its line.');
