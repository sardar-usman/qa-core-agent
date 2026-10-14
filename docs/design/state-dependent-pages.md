# State-dependent pages: design brief

Scope (STATE.md phase item 4, audit item 3): some pages exist only after an action. On practicesoftwaretesting.com the header cart link renders only after an add-to-cart, so a crawl of a fresh session never finds the cart page. This brief designs an action-first discovery rung: plan the feature where the action starts, reach the page by the action, and record it as reached by action, never as a URL to navigate to. Authenticated pages are the same problem with login as the action. No code changes here; the build PR follows.

## 1. Today

How a feature with no page gets planned, reached and scored:

- Planned. Discovery tags a page with a feature in two ways (`filterPages`, `page-filter.ts`): a path token match (`plainFeatureMatches`, `FEATURE_PATH_TOKENS`, where cart is `cart`, `basket`, `checkout`), or the Haiku relevance pick (`parsePickResponse`), which takes the feature name the model wrote. `unreachableFeatures` (`planner.ts`) compares map feature names with page tags by exact string and prints `Feature "<name>" has N rules and no discovered page` when no page carries the name. A model tag silences that line whatever the page holds.
- Reached. The plan entry's `pageUrl` is where the Explorer navigates first (`plannedPageViolation`, `planned-page.ts`). Anything past it is up to the Explorer's clicks.
- Scored. `computeRuleCoverage` (`rule-coverage.ts`) reads covered, planned-but-dropped, planned-not-explored, not-planned, or not-reachable (`NOT_REACHABLE_DETAIL`, only for a feature with no tagged page).

Evidence from the three Toolshop runs that share the SRS. Run folders under `output/practicesoftwaretesting-com/`. A "step" is the Nth `tool_call` event in `events.jsonl`; a "line" is the line number in that file.

| Evidence | Source (file, field) | Run 4 (591732) | Run 5 (51d535) | Run 6 (44cb3d) |
|---|---|---|---|---|
| a. Discovery method | `discovery.json` `method` | browser-crawl | browser-crawl | browser-crawl |
| a. Pages and tags | `discovery.json` `pages[].url`, `pages[].feature` | `/category/hand-tools` catalogue, `/contact` contact, `/auth/login` login, `/auth/register` registration, `/rentals` catalogue, `/` login, `/auth/forgot-password` registration | `/category/hand-tools` catalogue, `/contact` contact, `/auth/login` account, `/auth/register` account, `/rentals` catalogue, `/` cart, `/auth/forgot-password` account, `/privacy` contact | same eight pages and tags as run 5 |
| a. A page tagged cart | same | none | `/` | `/` |
| a. `/checkout` among candidates | `discovery.json` `candidates[].url` (14 per run) | no | no | no |
| b. Cart rules | `requirements-map.json` `features[name=cart].rules` | R6, R7, R8, R9 (texts below) | the same four, same texts | the same four, same texts |
| c. Plan entries citing a cart rule | `run-report.json` `plan[].ruleIds`, `pageUrl`, `category` | none of 20 | `plan[14]` R6, `plan[15]` R7, `plan[16]` R9; all happy, all `pageUrl` `/` | `plan[15]` R6, `plan[16]` R7, `plan[17]` R9; all happy, all `pageUrl` `/` |
| d. R6 | `run-report.json` `ruleCoverage.covered[]` / `uncovered[]` | not-planned | planned-but-dropped, detail "critic rework" | covered |
| d. R7 | same | not-planned | planned-but-dropped, detail "rework, not repaired: budget funds 5 of 9" | covered |
| d. R8 | same | not-planned | not-planned | not-planned |
| d. R9 | same | not-planned | planned-but-dropped, no detail | covered |
| e. First arrival at the cart page | `events.jsonl` `tool_call`, `tool_result` | absent in this run: no event names `/checkout` and no add-to-cart click was made | step 201 (line 587): click css `[data-test="nav-cart"]`, intent "cart icon in header"; step 202 asserts `toHaveURL` `/checkout` and passes; the `get_dom` result at line 594 reads url `/checkout` | step 199 (line 546): click testid `nav-cart`, intent "cart link in header"; the `get_dom` result at line 550 reads url `/checkout` |
| e. The actions before it | same | absent in this run | navigate `/` (196), click link by name "Bolt Cutters ABCDE$48.41" (197), click testid `add-to-cart` (199), assert `cart-quantity` text "1" (200) | navigate `/` (195), click `a[data-test^='product-']:first-of-type` (196), click testid `add-to-cart` (197), assert `cart-quantity` text "1" (198) |

The cart rules, verbatim from `requirements-map.json`: R6 "Adding a product from its detail page increases the cart count shown in the header." R7 "The cart page lists each added product with quantity and line total." R8 "Changing a quantity on the cart page updates the line total." R9 "Removing a product from the cart removes its row and updates the total."

What the table shows, and five facts behind it:

1. The cart tag on `/` in runs 5 and 6 came from the Haiku pick, not from the page. `/` has no path segment, so `plainFeatureMatches` cannot tag it; both runs print `narrowed to 8 (relevance pick)` (`events.jsonl`). Run 4's pick tagged `/` login, so cart had no page and all four rules read not-planned. That run predates the unreachable-feature line; no "no discovered page" line appears in any of the three `events.jsonl` files.
2. The page itself shows the cart link is state-dependent. In runs 5 and 6 no `get_dom` result before the first add-to-cart click lists testid `nav-cart` (13 and 11 results, on `/`, category, contact, auth, rentals and product pages). Every `get_dom` on `/checkout` lists `{"tag":"a","label":"cart","testid":"nav-cart"}` (1 in run 5, 2 in run 6). The product page (run 6, line 514) lists nine `nav-*` links and `{"tag":"button","label":"Add to cart","testid":"add-to-cart"}`. Run 4's `get_dom` results are 200-character previews, so run 4 cannot show this.
3. R8 was planned and rejected by page-fit on the wrong page. Runs 5 and 6 both print `Rejected page-fit scenario: "changed a product quantity on the cart page and the line total updated" on https://practicesoftwaretesting.com/: names quantity which the page snapshot does not show` (`events.jsonl` message). The page-fit check was right: `/` has no quantity field. The cart page has one. The rejection line carries no rule ids and no rule retry line appears, so the artefact does not say whether that scenario cited R8.
4. Run 5's R9 scenario is in `reconciliation.incomplete` ("cost ceiling hit mid-scenario; in-progress work discarded") while its coverage entry reads planned-but-dropped with no `detail`.
5. Run 6's shipped `tests/cart/cart.spec.ts` (in the zip) already sets its own state: the class url is `/` (`pages/cart-page.ts`), each test clicks a product, clicks add to cart and clicks the cart link. It never calls `page.goto` on `/checkout`. That shape came from the Explorer's choices, not from any rule.

So today the cart feature works only when the model happens to tag the entry page cart and the Explorer finds the path by itself. The plan is made from the wrong page's snapshot, so a cart-page control (R8's quantity field) is rejected as missing.

## 2. Detection

A feature is a state-dependent candidate when all three hold:

1. It has stated rules in the requirements map.
2. No candidate page carries it by page evidence: no SRS-stated URL, no user URL, and no path token match (`plainFeatureMatches` over ALL crawl candidates, before the filter). A tag from the Haiku pick does not count: it is model text, not page evidence (standing rule 1). Run 5's `/` tagged cart is the case this excludes.
3. Its tokens have a trigger row. A new table `STATE_TRIGGERS` (in a new `src/agent/state-probe.ts`) maps a feature's path tokens (`tokensFor` plus `featureTokenMap`) to trigger phrases: cart, basket and checkout to "add to cart", "add to basket", "add to bag"; wishlist to "add to wishlist", "add to favourites"; compare to "add to compare". Account pages use login as the trigger (section 7).

A candidate becomes state-dependent only on page evidence, from a browser probe with no model call (section 3):

- A trigger control exists: a button or link whose normalized label or test id (`normalizeWords`, the page-fit normalizer) contains a trigger phrase. Run 6's product page has `button "Add to cart"`, test id `add-to-cart`.
- The action reveals a link: after one click on the trigger, the same-origin anchors are read again (`waitForAnchors`, the browser crawl's settle) and compared with the set before the click. A NEW anchor whose path segment, normalized label or test id matches the feature's tokens is the revealed link. On Toolshop that is `a[data-test="nav-cart"]`, label "cart", and the click lands on `/checkout`, whose segment `checkout` is a cart token.

Matching is on normalized words against fixed tables and the feature's own tokens, never on a string the model wrote. The feature name only picks which table rows apply.

Not every rule of a state-dependent feature needs the revealed page. R6 ("Adding a product from its detail page increases the cart count shown in the header") is verified on the origin side: the add and the header count both happen before the cart link is followed. Such a rule is planned on the origin, with no `reachedBy`. The split is decided per rule from its own words, normalized like `featureTokenMap` reads rule content, never from a scenario name the model wrote:

- A rule whose words name the trigger's action (the verb of the trigger phrase that fired: "add" as add, adds, adding, added) and do not name the revealed page ("<feature token> page", such as "cart page", or a word of the revealed page's title or headings) is an origin rule. R6 is one: it says "adding" and "cart count", never "cart page".
- Every other rule of the feature is a revealed-page rule. R7 and R8 name "the cart page"; R9 names no add action.

Origin rules go to the origin page's plan call (its own sub-map plus these rules, judged by page-fit against the origin snapshot). Their scenarios carry `pageUrl` = the origin and no `reachedBy`. They are not refused by `navigated-to-reached-page`: that check refuses a navigate step to the feature's revealed page, and an origin scenario's only navigate is to the origin. Revealed-page rules go to the revealed page's plan call (section 4).

Never clicked, whatever the table says: a control whose normalized words name payment, an order, deletion or a subscription ("place order", "pay", "buy now", "checkout now", "delete", "remove account", "subscribe", "confirm purchase"). `STATE_TRIGGER_DENY` is checked before any click.

## 3. Origin page

The origin page is the stable page a scenario navigates to before the action starts.

1. Look for a trigger on the candidates, in this order: stable pages before volatile ones, then shallowest path, then crawl order. A page the browser crawl already loaded is read from that load where the build can keep the controls; otherwise it is loaded once more. At most `STATE_PROBE_PAGE_CAP` (4) pages are loaded per feature, `CRAWL_DELAY_MS` apart.
2. Click the trigger on the first page that has one, in a fresh context. At most `STATE_PROBE_CLICK_CAP` (2) trigger clicks per feature.
3. When the trigger page is volatile (Toolshop's `/product/<ulid>`), the origin is the stable page that linked to it. The crawl does not record that today: `walkCrawl` (`discovery.ts`) keeps a queue of `{ u, depth }` and no parent. New field `linkedFrom` on each crawl candidate. The action list then starts with a click on the item by its visible name (`via: 'item-link'`), as invariant 42 already requires.

Two pages qualify (both have a trigger and both reveal a link): the stable one wins; then the one whose revealed link matches more feature tokens; then the shallowest; then crawl order. Every qualifying page is listed on the probe record (`origins`), so the choice is visible.

None qualifies: no trigger on any page tried, or a trigger that revealed nothing. The probe records the outcome and every page and control it tried (section 5), and nothing is invented. The rule: the probe only adds a revealed page; it never removes planning that happens today. When the probe reveals nothing, the feature is planned exactly as on main, including on a page the page filter's model pick tagged (run 5's `/` tagged cart plans its cart scenarios as it did), and only the rules still uncited after planning read `not-revealed` with the probe's detail. Detection ignores a model tag when it decides whether to probe; planning never ignores one.

## 4. Recording

New field names, exact:

| Where | Field | Shape |
|---|---|---|
| `DiscoveredPage.source` (discovery.ts) | new value `'action'` | a page found by an action, not by a link in a fresh session |
| `DiscoveredPage` | `reachedBy?: ReachedBy` | `{ origin: string; feature: string; actions: ReachAction[] }` |
| new type `ReachAction` | | `{ kind: 'click' \| 'login'; control?: string; via?: 'item-link' }`; `control` is the locator as `emitLocatorCall` writes it, for example `getByTestId("nav-cart")` |
| `DiscoveredPage` (crawl candidates) | `linkedFrom?: string` | the page whose anchor led to this candidate |
| `DiscoveryResult`, `discovery.json`, `report.discovery` | `stateProbes?: StateProbe[]` | one entry per candidate feature, section 5 |
| `PlannedScenario` (planner.ts) | `reachedBy?: { pageUrl: string; origin: string; actions: ReachAction[] }` | `pageUrl` on the scenario stays the origin; `reachedBy.pageUrl` is the revealed page |
| `ToolContext.plannedPages` (tools.ts) entries | `reachedPageUrl?: string` | set for every scenario of a feature with a revealed page, `reachedBy` or not; read by end_scenario |
| `PlannedPageViolation.kind` (planned-page.ts) | new value `'navigated-to-reached-page'` | |
| `UncoveredReason` (rule-coverage.ts) | new value `'not-revealed'` | section 5 |

How each record reads on Toolshop:

- `discovery.json` `pages` gains `{ "url": "https://practicesoftwaretesting.com/checkout", "source": "action", "feature": "cart", "reachedBy": { "origin": "https://practicesoftwaretesting.com/", "feature": "cart", "actions": [ { "kind": "click", "via": "item-link" }, { "kind": "click", "control": "getByTestId(\"add-to-cart\")" }, { "kind": "click", "control": "getByTestId(\"nav-cart\")" } ] } }`. `candidates` keeps the crawl list unchanged; `/checkout` is never written there as a crawled page.
- The plan. The revealed page is planned from a snapshot taken in the probe's own context after the action (the cart page with one item in it). `plan()` launches its own browser and has no client seam today, so it gains `snapshot?: PageSnapshot` and `client?` options. Page-fit judges against that snapshot, so R8's quantity field is evidenced. This call takes the feature's revealed-page rules (section 2); each of its scenarios gets `pageUrl` = the origin and `reachedBy`. Origin rules are planned on the origin with no `reachedBy`. The Planner's per-page block names the actions and says the revealed URL is never navigated to.
- `dedupeAcrossPages` keeps the copy on the page whose tag names the feature. The revealed page's tag is page evidence, so its cart scenarios win over a cart copy a model tag put on `/`.
- The Explorer's plan text prints `page: <origin>` and `reached by: <actions>; do NOT navigate to <revealed path>`, like the volatile-page line today.
- end_scenario: `plannedPageViolation` refuses a trace with a navigate step to the feature's revealed page (`reachedPageUrl`, `navigated-to-reached-page`), for every scenario of that feature, under the same refusal, teaching text and `PLANNED_PAGE_CAP` strike rule as invariant 65. The origin navigate is still required. A volatile item hop stays exempt from the navigate check, as today.
- run-report.json: `plan[].reachedBy` and `report.discovery.stateProbes`. No URL to navigate to is ever stored for the revealed page outside `reachedBy.pageUrl`.

## 5. Failure

Every probe writes a record, revealed or not:

`StateProbe = { feature: string; outcome: 'revealed' | 'no-trigger' | 'no-new-link' | 'robots' | 'no-credentials' | 'error'; origins: string[]; tried: Array<{ url: string; control?: string; result: string }>; revealed?: string; detail: string }`

- Console, one line per feature, never cut by the message cap (it is printed whole like the resume hint). Revealed: `State probe "cart": revealed /checkout from / (click an item, getByTestId("add-to-cart"), getByTestId("nav-cart"))`. Not revealed: `State probe "cart": no page revealed; tried / (no trigger), /category/hand-tools (no trigger), /product/01M3... (clicked getByTestId("add-to-cart"), no new cart link within 3000 ms); its 4 rules will report not-revealed`.
- `unreachableFeatureLine` stops saying "no discovered page" for a feature a probe ran on; it prints the probe line instead. A feature with no trigger row keeps today's line.
- Report: `report.discovery.stateProbes` and `discovery.json` `stateProbes` carry the same records.
- Rule coverage: a rule of a feature whose probe did not reveal a page reads `not-revealed` with the probe's `detail` only when it is still uncited after planning. A rule a scenario cites (on a page the model pick tagged, as on main) is classified exactly as on main and never reads `not-revealed`. The probe only adds a revealed page; it never removes planning that happens today (section 3). An uncited rule reads (for example `no page revealed: tried /, /category/hand-tools, /product/01M3...`), rendered `R8 (not-revealed: no page revealed: tried ...)`. Never a plain not-planned, never an empty page list. The index maps `not-revealed` to its coarse `not_planned` status like `not-reachable` today (`UNCOVERED_STATUS`, no schema change); the report and console carry the reason.
- An `error` outcome (the browser failed, a timeout) is its own outcome with the message, never read as "no trigger".

## 6. Emitted framework

A test for a state-dependent page sets its own state in its steps and never calls `page.goto` on the revealed URL.

- The recorded trace is the source: the Explorer navigates to the origin and clicks through, and end_scenario refuses a navigate to the revealed page (section 4). Both emitters write recorded steps only, so the spec inherits the shape. Run 6's cart spec is this shape already, by luck.
- Each test adds its own item. The beforeEach clears cookies and storage (invariant 4), so no test depends on another's cart. A shared `beforeEach` goto is emitted only when every scenario of the feature starts on the same origin (invariant 62); here they do, so the class url is the origin.
- Volatile ids stay reached by click. The item hop clicks by visible name or a durable test id prefix; gate RULE 6 already refuses a selector holding a generated id (`generatedIdFragment`, `volatile-id.ts`), and the revealed path is never navigated to even when it is stable, like `/checkout`.
- A smoke greps the emitted spec for a `page.goto` on any `reachedBy.pageUrl` and fails on a hit, in TS and JS, POM and single file.

## 7. Authenticated pages

The same mechanism with login as the action.

- Detection from the page: a candidate whose fresh-session load ends on a login page (the final URL matches `LOGIN_PATHS`, or the page shows a password input and the requested path differs). And new anchors that appear only after a sign-in, matching an account feature's tokens (`account`, `profile`, plus `orders`, `invoices`, `favorites` added to `FEATURE_PATH_TOKENS`).
- The probe reuses the login preflight that already runs before discovery (`runLoginPreflightGate`, invariant 70). `preflightLogin` gains the anchors it saw after a successful sign-in and an in-memory storage state for the probe's context. The session is never written to disk (invariant 70 (g), and the PR #45 rule that a session file never reaches a zip). Revealed pages carry `actions: [ { kind: 'login' }, { kind: 'click', control } ]`.
- No credentials: outcome `no-credentials`, detail `test credentials not provided`. The generic pair with no login page found: detail `no login page found` (`NO_LOGIN_PAGE_REASON`). Both are loud lines and `not-revealed` rules, never a quiet not-planned.
- The wrong-password cap. The probe types the correct password once, inside the preflight sign-in that already happens, so it adds nothing to `wrongPasswordAttempts`. Every exploration, replay, stability and emitted execution of a reached-by-login scenario signs in with the marker (correct password), which the ledger never counts.
- storageState in the emitted framework. The main project already loads the auth setup's state and strips leading login steps (`stripLeadingLogin`, invariant 45). A reached-by-login test therefore starts signed in, opens the origin (the page the post-login link sits on) and clicks through. It never calls `page.goto` on the revealed URL, the same rule as section 6, so one check covers both.

Decided (PR #46): a scenario that opens a gated URL signed out (for example "visiting /account signed out redirects to login") is not planned in the build PR. The never-navigate rule has no exemption, by category or otherwise. The reached-by block tells the Planner not to plan one, and if one is recorded anyway, end_scenario refuses its navigate to the revealed page like any other. The idea is recorded in the STATE.md audit backlog.

## 8. Cost and politeness

- Model calls. The probe makes none: Playwright and fixed tables only. The Planner makes one Haiku call per revealed page. Runs 4 to 6 paid $0.0038 to $0.0055 per page (`Planner [i/n]` lines in `events.jsonl`), so about $0.005 per revealed page; Toolshop has one (cart), so about $0.005 per run. `PER_PAGE_SCENARIO_CAP` (4) and `GLOBAL_PLAN_CAP` (20) are unchanged, and the revealed page's scenarios count toward both.
- Explorer cost. No new kind of work: runs 5 and 6 already explored three cart scenarios each (section 1). The steps are the same clicks, now planned.
- Crawl rules unchanged. `CRAWL_PAGE_CAP` 15, `CRAWL_VOLATILE_CAP` 3, `CRAWL_MAX_DEPTH` 2, `CRAWL_DELAY_MS` 500, the browser crawl's user agent, same origin only. The probe adds at most 4 page loads and 2 trigger clicks per candidate feature, sequential, 500 ms apart.
- robots.txt. The probe loads no origin page robots disallows, and clicks no revealed link whose path robots disallows (outcome `robots`, the disallowed path named).
- A trigger click changes site state (an item in a throwaway cart). That is what the Explorer already does on every cart scenario; the deny list in section 2 keeps purchases and deletions out.

## 9. The build PR

Branch `engine/state-dependent-pages`, in order:

1. `src/agent/state-probe.ts` (new): `STATE_TRIGGERS`, `STATE_TRIGGER_DENY`, `findTriggers`, `probeStateFeature`, `splitRulesByPage` (the origin or revealed-page split of section 2), `StateProbe`, `stateProbeLine`, `STATE_PROBE_PAGE_CAP`, `STATE_PROBE_CLICK_CAP`.
2. `discovery.ts`: `source: 'action'`, `reachedBy`, `ReachAction`, `linkedFrom` from `walkCrawl`, `stateProbes` on `DiscoveryResult` and in `writeDiscoveryJson`.
3. `page-filter.ts`: export which candidates carry a feature by path token, so detection ignores pick tags.
4. `planner.ts`: `plan()` takes `snapshot` and `client`; the reached-by block; `PlannedScenario.reachedBy`; `unreachableFeatures` and its line read the probes.
5. `runtime.ts`: run the probe after `filterPages` for each candidate feature; plan revealed pages; plan text; `plannedPages` carries `reachedPageUrl`.
6. `planned-page.ts` and `tools.ts`: `navigated-to-reached-page`.
7. `rule-coverage.ts`: `not-revealed`; the indexer's `UNCOVERED_STATUS` row.
8. `login-preflight.ts`: post-login anchors and in-memory state (section 7).
9. CLAUDE.md: invariant 71; invariants 28, 42, 55 (d), 61 (c) and 65 amended to point at it.

Invariant 71 text:

> **71. A page that exists only after an action is reached by that action, recorded as reached by action, and never navigated to by URL.** A requirements feature with rules and no page carrying it by page evidence (an SRS or user URL, or a path token; a tag from the page filter's model pick does not count) is probed in a browser with no model call: `probeStateFeature` (`state-probe.ts`) looks for a trigger control from `STATE_TRIGGERS` on at most `STATE_PROBE_PAGE_CAP` (4) candidates, stable before volatile, clicks at most `STATE_PROBE_CLICK_CAP` (2), never a control in `STATE_TRIGGER_DENY`, and takes the revealed page from the same-origin anchors that appear after the click and match the feature's tokens. A volatile trigger page's origin is the stable page that linked to it (`linkedFrom`). The revealed page is written to `discovery.json` and `report.discovery` with `source: 'action'` and `reachedBy` (origin and actions); a rule whose words name the trigger's action and not the revealed page is planned on the origin with no `reachedBy`; every other rule of the feature is planned from the probe's post-action snapshot with the scenario's `pageUrl` set to the origin and `reachedBy.pageUrl` to the revealed page; and end_scenario refuses a navigate to the revealed page for every scenario of the feature (`navigated-to-reached-page`, invariant 65's strike rule), with no exemption. Login is the same action for authenticated pages, through the preflight's own sign-in (invariant 70), with no session written to disk. Every probe is recorded (`stateProbes`) and printed as one whole line; a probe that revealed nothing names every page and control it tried. The probe only adds a revealed page and never removes planning that happens today: when it reveals nothing, the feature is planned exactly as on main, a page the page filter's model pick tagged included, and only rules still uncited after planning read `not-revealed` with that detail. Crawl caps, delays and robots rules (invariants 28 and 29) are unchanged; robots is honored for the origin and the revealed path. Locked by `smoke-state-probe`, `smoke-planned-page`, `smoke-rule-coverage`, `smoke-discovery-ladder`, `smoke-plan-page-fit` and `smoke-emitted-run`.

Locks:

- `smoke-state-probe` (new): a local fixture site served in-process with `node:http`, like `smoke-emitted-run`. Pages: `/` (a listing linking to `/product/01HXXXXXXXXXXXXXXXXXXXXXXX`), the product page (an "Add to cart" button), `/checkout` (rows with a quantity input). The header cart link is rendered by script only after the add click. Checks: detection ignores a model tag on `/`; the probe reveals `/checkout` from `/` through the item hop with no model call; `discovery.json` holds `source: 'action'` and `reachedBy` and no crawled `/checkout`; a variant with no trigger, one with a trigger that reveals nothing, and one whose robots disallows `/checkout` each produce their outcome, the whole console line and `not-revealed` with the pages tried; a "Place order" button is never clicked; two qualifying origins pick the stable one and list both; a variant where the probe reveals nothing and a model-tagged page exists (the page filter's pick given as a fixture result, `/` tagged cart) still plans that page's scenarios exactly as on main, and their cited rules never read `not-revealed`, only the uncited ones do; R6's fixture rule is planned on `/` with no `reachedBy` and its trace is accepted, while a revealed-page rule's trace that navigates to `/checkout` is refused.
- `smoke-planned-page`: a trace with a navigate to the revealed page is refused, a second strike goes to `brokenByGate`, and the click path is accepted.
- `smoke-rule-coverage`: `not-revealed` with its detail; a cited rule never reads it.
- `smoke-discovery-ladder`: `linkedFrom` on crawl candidates; caps, delay and robots unchanged.
- `smoke-plan-page-fit`: a quantity scenario is kept on the revealed snapshot and still rejected on `/`.
- `smoke-emitted-run`: a fixture run-report with a reached-by-action cart scenario emits no `page.goto` to `/checkout` and executes green against the fixture site in TS and JS.
- `smoke-test-credentials`: a fixture login reveals `/account`; the ledger is unchanged; no session file is written.

The $0 proof: the build PR runs the full chain on the fixture site with no model call. Discovery and the probe are browser-only; `plan()` is driven through its new `snapshot` and `client` options with a fixture Planner response; the pipeline's later stages are driven from a fixture run-report as `smoke-emitted-run` does, and the emitted framework executes against the fixture site. Paste the `discovery.json`, the probe line, the coverage line and the Playwright result in the PR.

## 10. Risks, ranked

1. A trigger with side effects that matter on a client's site (an order, a deletion, a subscription). Loud: the deny list is checked before any click and every click is named on the probe record. Residual: a site may label a destructive control in words the list misses.
2. A probe that reveals the wrong page (a new anchor that matches a token by accident, such as a "cart" help link). Loud: the revealed URL and the control are on the console line and in `discovery.json`. Check: the revealed page must be absent from the pre-click anchors, same origin, and matched by token, not by position.
3. The revealed page needs more state than one click (a cart page that shows nothing until checkout is started). Loud: the probe snapshot shows no feature controls and page-fit rejects the scenarios by name, as on `/` today.
4. A client's real account signs in many times per run on authenticated pages (every execution of every reached-by-login scenario). Some sites rate-limit sign-ins. Loud: the post-run lockout check (`postRunLockoutCheck`) still runs; open whether to count correct sign-ins too.
5. Run order cost: the revealed page's scenarios take plan slots from other pages under the 20 cap. Loud: the existing cap lines name the pages not planned.
6. A site whose trigger is not in `STATE_TRIGGERS`. The feature is planned as on main, and its rules still uncited after planning read `not-revealed` with `no trigger` and every page tried; the table grows by evidence from runs, never by guessing.
7. A rule split to the wrong side (section 2). An origin rule that really needs the revealed page is judged by page-fit against the origin snapshot and may be rejected by name, as R8 was on `/`; a revealed-page rule that needs no cart page costs a few extra clicks. Loud: the page-fit line names the scenario, and the plan records which side each rule went to (`reachedBy` present or absent).
