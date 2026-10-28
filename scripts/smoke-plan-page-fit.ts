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
 *   - a quantity scenario is kept on a page reached by action (the probe's
 *     post-action cart snapshot) and still rejected on "/" (invariant 71)
 *
 *   - F9: run 7's catalogue edge R5 pair on / and /privacy (overlap 0.69)
 *     is one scenario, because /privacy does not carry catalogue by page
 *     evidence; one line names both scenarios and the overlap (invariant 78)
 *
 * In-code fixtures plus one local page in headless Chromium for the flags.
 * No network. No LLM.
 */
import { chromium } from 'playwright';
import {
  pageFitReason,
  rejectPageFit,
  normalizeWords,
  formNamePhrases,
  dedupeAcrossPages,
  nameOverlap,
  crossPageBasisText,
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
import { planAcrossPages, targetEvidence, type PlanTarget } from '../src/agent/plan-pages.js';
import type { PlanResult } from '../src/agent/planner.js';
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

/* ─── A0. run 51d535: the page's own form name is not a field ─────────────── */
// Three valid forgot-password scenarios were dropped on /auth/forgot-password
// as "names password which the page snapshot does not show": the word named
// the form. The heading (and the path) give the form-name phrase, which is
// removed from the name before field matching; a bare "password" still names
// the field.
const run5Names = [
  'submitted forgot-password form with a valid email and received a confirmation message',
  'rejected forgot-password form with empty email field and showed required-field error',
  'rejected forgot-password form with an invalid email format and showed format error',
];
check('A0a. the forgot-password snapshot yields the form-name phrase "forgot password"', formNamePhrases(forgotPassword).join(',') === 'forgot password', JSON.stringify(formNamePhrases(forgotPassword)));
for (const [i, n] of run5Names.entries()) {
  const r = pageFitReason(sc(n, i === 0 ? 'happy' : 'negative', 'account'), forgotPassword);
  check(`A0${'bcd'[i]}. run 5 name ${i + 1} is KEPT on the forgot-password page`, r === null, JSON.stringify(r));
}
check('A0e. a "first name" scenario on that page is still dropped', pageFitReason(sc('rejected forgot-password form with an empty first name', 'negative', 'account'), forgotPassword)?.control === 'first name');
const fromPath = formNamePhrases({ headings: [], url: 'https://s.example/auth/forgot-password' });
const fromTitle = formNamePhrases({ headings: [], title: 'Reset Password | Toolshop' });
check('A0f. the path segment and a title segment give the phrase too; a one-word heading and a non-field heading give none', fromPath.join(',') === 'forgot password' && fromTitle.join(',') === 'reset password' && formNamePhrases({ headings: [{ tag: 'h1', label: 'Password' }, { tag: 'h2', label: 'Hand Tools' }] }).length === 0, JSON.stringify([fromPath, fromTitle]));

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

/* ─── F8. cross-page dedup on meaning, not exact name (invariant 73) ─────── */
{
  // Run 44cb3d D9: two reworded duplicate-email negatives on /auth/login and
  // /auth/register, both account, negative, R11; the exact-name key missed them.
  const registerUrl = 'https://s.example/auth/register';
  const withRules = (name: string, pageUrl: string, ruleIds: string[]): PlannedScenario => ({ ...sc(name, 'negative', 'account', pageUrl), ruleIds });
  const usedA = 'rejected registration with an already-used email address and showed an error';
  const usedB = 'rejected registration with an already-used email address and error displayed';
  const emptyEmail = 'rejected registration with empty email';
  const malformedEmail = 'rejected registration with malformed email';
  const features = pageFeature({ [loginUrl]: 'login', [registerUrl]: 'account' });
  const reworded = dedupeAcrossPages([withRules(usedA, loginUrl, ['R11'])], [withRules(usedB, registerUrl, ['R11'])], { url: registerUrl, feature: 'account' }, features);
  const apart = dedupeAcrossPages([withRules(emptyEmail, loginUrl, ['R11'])], [withRules(malformedEmail, registerUrl, ['R11'])], { url: registerUrl, feature: 'account' }, features);
  const otherRule = dedupeAcrossPages([withRules(usedA, loginUrl, ['R11'])], [withRules(usedB, registerUrl, ['R12'])], { url: registerUrl, feature: 'account' }, features);
  const noRules = dedupeAcrossPages([withRules(usedA, loginUrl, [])], [withRules(usedB, registerUrl, [])], { url: registerUrl, feature: 'account' }, features);
  const show = (label: string, r: ReturnType<typeof dedupeAcrossPages>, overlap: number): void =>
    console.log(`  F8 lock: ${label}: overlap ${overlap.toFixed(2)} -> ${r.dropped.length ? `duplicate (${crossPageBasisText(r.dropped[0]!.basis)})` : 'kept apart'}`);
  show('already-used email, showed an error vs error displayed, both R11', reworded, nameOverlap(usedA, usedB));
  show('empty email vs malformed email, both R11', apart, nameOverlap(emptyEmail, malformedEmail));
  show('already-used email pair, R11 vs R12', otherRule, nameOverlap(usedA, usedB));
  show('already-used email pair, no rule ids', noRules, nameOverlap(usedA, usedB));
  check('F8a. the reworded pair overlaps by 0.78 (7 shared words of 9)', Math.abs(nameOverlap(usedA, usedB) - 7 / 9) < 1e-9 && nameOverlap(usedA, usedB).toFixed(2) === '0.78');
  check('F8b. the reworded pair with the same feature, category and rule R11 is one scenario; the copy on the account page is kept',
    reworded.dropped.length === 1 && reworded.dropped[0]!.scenario.name === usedA && reworded.incoming.length === 1 && reworded.incoming[0]!.name === usedB
    && crossPageBasisText(reworded.dropped[0]!.basis) === 'same feature, category and rules R11, names overlap 0.78', JSON.stringify(reworded.dropped));
  check('F8c. empty email vs malformed email (overlap 0.60) are kept apart', apart.dropped.length === 0 && nameOverlap(emptyEmail, malformedEmail).toFixed(2) === '0.60', JSON.stringify(apart.dropped));
  check('F8d. the reworded pair citing different rule ids is kept apart', otherRule.dropped.length === 0, JSON.stringify(otherRule.dropped));
  check('F8e. the reworded pair citing no rule ids is kept apart (the set must be non-empty)', noRules.dropped.length === 0, JSON.stringify(noRules.dropped));
  check('F8f. an exact-name duplicate still reads the original reason', crossPageBasisText({ kind: 'name' }) === 'same feature, category and intent');
}

/* ─── F9. cross-page duplicates by page evidence (invariant 78, run 59540f D7f) ─── */
{
  // Run 7 planned the catalogue edge R5 scenario on / (plan[3]) and again on
  // /privacy (plan[8]); the names overlap 0.69, under the 0.75 rule, so both
  // stayed and the Explorer spent a call skipping the /privacy copy.
  const HOME = 'https://practicesoftwaretesting.com/';
  const PRIVACY = 'https://practicesoftwaretesting.com/privacy';
  const CATEGORY = 'https://practicesoftwaretesting.com/category/hand-tools';
  const onHome = 'clicked product from listing, navigated to detail page showing same name and price as the listing';
  const onPrivacy = 'clicked product opened detail page with same name and price as listing';
  const r5 = (name: string, ruleIds = ['R5']): PlannedScenario => ({ name, category: 'edge', feature: 'catalogue', rationale: 'fails if the detail page differs', ruleIds });
  const planOn = async (second: string, secondPlan: PlannedScenario[]) => {
    const lines: string[] = [];
    const targets: PlanTarget[] = [{ page: { url: HOME, source: 'sitemap' } }, { page: { url: second, source: 'sitemap' } }];
    const planFn = async (a: { url: string }): Promise<PlanResult> => ({
      scenarios: a.url === HOME ? [r5(onHome)] : secondPlan, fillableFields: 0, costUsd: 0, dropped: [], rejected: [], citationDrops: [], pageFitRejected: [], contradictionRejected: [], ruleRetries: [],
    } as unknown as PlanResult);
    const r = await planAcrossPages({ targets, planFn, onMessage: (t) => lines.push(t) });
    return { r, lines };
  };
  check('F9a. run 7\'s pair overlaps by 0.69 (9 shared words of 13), under the 0.75 overlap rule', Math.abs(nameOverlap(onHome, onPrivacy) - 9 / 13) < 1e-9 && nameOverlap(onHome, onPrivacy).toFixed(2) === '0.69');
  const before = dedupeAcrossPages([{ ...r5(onHome), pageUrl: HOME }], [{ ...r5(onPrivacy), pageUrl: PRIVACY }], { url: PRIVACY }, () => undefined);
  check('F9b. without the page-evidence check the pair is kept apart (the overlap rule alone, as before)', before.dropped.length === 0 && before.incoming.length === 1, JSON.stringify(before.dropped));
  const run7 = await planOn(PRIVACY, [r5(onPrivacy)]);
  const dropLine = run7.lines.find((l) => l.startsWith('Rejected cross-page duplicate'));
  console.log(`  F9 lock: ${dropLine}`);
  check('F9c. planned through planAcrossPages, the /privacy copy is a cross-page duplicate: /privacy does not carry catalogue by page evidence, whatever the overlap',
    run7.r.combined.length === 1 && run7.r.combined[0]!.name === onHome && run7.r.combined[0]!.pageUrl === HOME, JSON.stringify(run7.r.combined.map((x) => [x.name, x.pageUrl])));
  check('F9d. one line names both scenarios and the overlap value',
    dropLine === `Rejected cross-page duplicate: "${onPrivacy}" on ${PRIVACY} (same feature, category and rules R5, and /privacy does not carry catalogue by page evidence, names overlap 0.69, as "${onHome}" kept on ${HOME})`, dropLine);
  const onCategory = await planOn(CATEGORY, [r5(onPrivacy)]);
  check('F9e. on a page that carries catalogue by page evidence (/category/hand-tools) the same pair is kept apart (0.69 is under the overlap rule)',
    onCategory.r.combined.length === 2 && !onCategory.lines.some((l) => l.startsWith('Rejected cross-page duplicate')), JSON.stringify(onCategory.lines));
  const otherRule = await planOn(PRIVACY, [r5(onPrivacy, ['R4'])]);
  check('F9f. a different rule set on /privacy is not a duplicate (the rule set must match and be non-empty)', otherRule.r.combined.length === 2, JSON.stringify(otherRule.lines));
  const sameName = await planOn(PRIVACY, [r5(onHome)]);
  check('F9g. an exact-name copy still reads the original reason, unchanged', sameName.lines.some((l) => l === `Rejected cross-page duplicate: "${onHome}" on ${PRIVACY} (same feature, category and intent as the scenario kept on ${HOME})`), JSON.stringify(sameName.lines));
  const ev = targetEvidence([
    { page: { url: 'https://s.example/store', source: 'srs', feature: 'catalogue' } },
    { page: { url: 'https://s.example/checkout', source: 'action', feature: 'cart' } },
    { page: { url: 'https://s.example/', source: 'crawl' }, originOf: ['cart'] },
    { page: { url: 'https://s.example/', source: 'crawl', feature: 'catalogue' } },
    { page: { url: CATEGORY, source: 'crawl' } },
  ]);
  check('F9h. page evidence: an SRS-tagged page, a page reached by action, a probe origin and a path token carry the feature; a model tag alone does not',
    ev('https://s.example/store', 'catalogue') && ev('https://s.example/checkout', 'cart') && ev('https://s.example/', 'cart') && ev(CATEGORY, 'catalogue') && !ev('https://s.example/', 'catalogue') && !ev(PRIVACY, 'catalogue'));
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

/* ─── J. a page reached by action: page-fit judges the post-action snapshot ── */
// Runs 5 and 6 rejected R8's scenario on "/" (no quantity field there). The
// state probe plans the cart rules from the cart page as it looks after an
// add (invariant 71), where the quantity field is real.
{
  const r8 = sc('changed a product quantity on the cart page and the line total updated', 'happy', 'cart', 'https://s.example/');
  const home: PageFitSnapshot = {
    headings: [{ tag: 'h1', label: 'Toolshop' }, { tag: 'h2', label: 'Products' }],
    inputs: [{ tag: 'input', label: 'Search', type: 'search' }],
    buttons: nav,
    textSample: 'Home Categories Contact Sign in Combination Pliers $14.15 Hammer $12.01',
    tableHeaders: [],
    frames: [],
  };
  const cartAfterAdd: PageFitSnapshot = {
    headings: [{ tag: 'h1', label: 'Cart' }],
    inputs: [{ tag: 'input', label: 'Quantity', type: 'number' }],
    buttons: [...nav, { tag: 'button', label: 'Remove', type: 'button' }],
    textSample: 'Cart Combination Pliers 1 $14.15 Remove Total $14.15 Proceed to checkout',
    tableHeaders: ['Item', 'Quantity', 'Price', 'Total'],
    frames: [],
  };
  check('J1. the quantity scenario is still rejected on "/" (runs 5 and 6)', pageFitReason(r8, home)?.control === 'quantity', JSON.stringify(pageFitReason(r8, home)));
  check('J2. the same scenario is kept on the revealed cart snapshot', pageFitReason(r8, cartAfterAdd) === null, JSON.stringify(pageFitReason(r8, cartAfterAdd)));
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: page-fit drops a scenario that names a control the snapshot does not show, keeps a scenario that names the page\'s own form, cross-page duplicates collapse to one, the funnel balances after the drops, derivation says page-fit, an unreachable SRS feature prints its line, and a page reached by action is judged on its post-action snapshot.');
