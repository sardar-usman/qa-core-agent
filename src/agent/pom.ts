import fs from 'node:fs';
import path from 'node:path';
import { emitLocatorCall, type CascadeLevel } from './selectors.js';
import { selectOptionExpr, filesArg } from './transcriber.js';
import { uniqueCallExpr, uniqueFnName } from './unique-data.js';
import { regexLiteral } from './transcriber.js';
import { COMPARE_POLL_TIMEOUT_MS } from './replay.js';
import { deriveDatasets, renderDatasetJson, type DatasetCase, type FeatureDataset } from './datasets.js';
import { envForCredentialValue, recordedCredentials, stripLeadingLogin, type AuthCredentials } from './auth-emit.js';
import type { RequirementsMap } from './requirements.js';
import type { Assertion, CaptureSource, GenerateKind, RunReport, Scenario, SelectorRecord, TraceStep } from './trace.js';

// The assert_compare poll timeout is the replay engine's own (COMPARE_POLL_TIMEOUT_MS),
// so the spec waits exactly as long as the in-process check did.

/**
 * Page Object Model emitter.
 *
 * Takes the verified RunReport and produces a real Playwright framework:
 *
 *   output/<run-id>/
 *     pages/
 *       BasePage.ts                    base class with goto + expectVisible helpers
 *       <FeaturePage>.ts               one per detected logical page
 *     tests/
 *       <feature>.spec.ts              spec using the page objects
 *     tests/a11y/
 *       landing.a11y.spec.ts           auto-injected accessibility check
 *                                       (sits inside tests/ so it runs by
 *                                       default — testDir is './tests')
 *     run-report.json                  same as before
 *
 * Design rules:
 *   - Locators that appear in 2+ scenarios get hoisted into a class field.
 *   - Common step sequences (e.g. fill+fill+click) get synthesized as action
 *     methods on the page class (e.g. `loginAs(user, pass)`).
 *   - One page object per distinct URL pathname. The hostname becomes the
 *     suite title; the pathname segment becomes the page class name.
 *   - When the trace has only one scenario, we still emit POM (the user picked
 *     this mode explicitly), but with a minimal page class.
 */

export interface POMTranscribeOptions {
  report: RunReport;
  outDir: string;
  /** Filename root for the generated spec (no extension). */
  name: string;
  /** Requirements map (SRS runs); enriches datasets with rule-derived cases. */
  requirements?: RequirementsMap;
  /**
   * The happy login scenario the auth setup replays (auth-emit.ts found one).
   * When set: authenticated-feature scenarios lose their leading login steps
   * (storageState replaces them), login-spec credential fills become env
   * references, and the login spec keeps its cookie-clearing beforeEach while
   * authenticated specs keep the session. When absent, emission is untouched.
   */
  authLogin?: Scenario | null;
}

export interface POMTranscribeResult {
  rootDir: string;
  /** All emitted page-object files including BasePage. */
  pageFiles: string[];
  /**
   * One spec file per feature group, located at tests/<feature>/<feature>.spec.{ext}.
   * Order matches the feature group order produced by groupScenariosByFeature.
   */
  specFiles: string[];
  /**
   * The "primary" spec file path — a convenience for code that wants to
   * point at one representative test (e.g. console output "Run: npx
   * playwright test <spec>"). Always equals specFiles[0] when at least one
   * group emitted; empty string when there were no scenarios.
   */
  specFile: string;
  a11yFile: string;
  scenarios: number;
  /** Distinct feature names that produced a page object + spec folder. */
  features: string[];
  /** data/<feature>.json files written for parameterized specs (may be empty). */
  dataFiles: string[];
}

/* ───────────────────────── Entry point ───────────────────────── */

export function transcribePOM(opts: POMTranscribeOptions): POMTranscribeResult {
  const { outDir } = opts;
  fs.mkdirSync(path.join(outDir, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'tests', 'a11y'), { recursive: true });

  // storageState auth: authenticated-feature scenarios lose their leading
  // login sequence BEFORE grouping, so page classes and specs are built from
  // the steps that will actually run. Login-feature scenarios keep every
  // step (a logged-in login test is vacuous, so they run without storage
  // state). Without authLogin the report passes through untouched, byte for
  // byte — the emitter-only guarantee.
  const report: RunReport = opts.authLogin
    ? {
        ...opts.report,
        scenarios: opts.report.scenarios.map((s) =>
          s.feature === 'login' ? s : { ...s, steps: stripLeadingLogin(s.steps) },
        ),
      }
    : opts.report;

  const ext = report.language;
  const pageGroups = groupScenariosByFeature(report);
  const pageClasses = pageGroups.map((pg) => buildPageClass(pg, ext));

  // Dataset parameterization: per feature, scenarios sharing one action
  // signature with 2+ dataset cases collapse into a single data-driven loop.
  const datasets = deriveDatasets(report, opts.requirements);
  const paramPlans = new Map<string, ParamPlan>();
  for (const pc of pageClasses) {
    const ds = datasets.find((d) => d.feature === pc.feature);
    if (!ds) continue;
    const plan = buildParamPlan(pc, ds);
    if (plan) paramPlans.set(pc.feature, plan);
  }
  const dataFiles: string[] = [];
  if (paramPlans.size > 0) {
    fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });
    for (const [feature, plan] of paramPlans) {
      const dataFile = path.join(outDir, 'data', `${feature}.json`);
      fs.writeFileSync(dataFile, renderDatasetJson({ feature, cases: plan.cases }));
      dataFiles.push(dataFile);
    }
  }

  // Emit BasePage (shared).
  const baseFile = path.join(outDir, 'pages', `BasePage.${ext}`);
  fs.writeFileSync(baseFile, renderBasePage(ext));

  // Emit one <feature>-page.{ext} per feature group.
  const pageFiles: string[] = [baseFile];
  for (const pc of pageClasses) {
    const file = path.join(outDir, 'pages', `${pc.pageFileBase}.${ext}`);
    fs.writeFileSync(file, renderPageClass(pc, ext));
    pageFiles.push(file);
  }

  // Emit one spec per feature at tests/<feature>/<feature>.spec.{ext}.
  // Each spec contains only the scenarios for that feature.
  const specFiles: string[] = [];
  const features: string[] = [];
  for (const pc of pageClasses) {
    const specDir = path.join(outDir, 'tests', pc.specFolder);
    fs.mkdirSync(specDir, { recursive: true });
    const specFile = path.join(specDir, `${pc.specFolder}.spec.${ext}`);
    fs.writeFileSync(specFile, renderSpec(report, pc, ext, {
      param: paramPlans.get(pc.feature),
      authActive: Boolean(opts.authLogin),
      authCreds: opts.authLogin ? recordedCredentials(opts.authLogin) : null,
    }));
    specFiles.push(specFile);
    features.push(pc.feature);
  }

  // a11y test lives under tests/a11y/ so playwright's default testDir picks
  // it up alongside functional tests — no manual `npx playwright test a11y/`
  // needed. Still namespaced into its own subfolder for separation of concern.
  const a11yFile = path.join(outDir, 'tests', 'a11y', `landing.a11y.spec.${ext}`);
  fs.writeFileSync(a11yFile, renderA11ySpec(report.url, ext));

  return {
    rootDir: outDir,
    pageFiles,
    specFiles,
    specFile: specFiles[0] ?? '',
    a11yFile,
    scenarios: report.scenarios.length,
    features,
    dataFiles,
  };
}

/* ───────────────────────── Dataset parameterization ───────────────────────── */

interface ParamPlan {
  /** Scenarios collapsed into the data-driven loop (skipped as individual tests). */
  members: Set<Scenario>;
  /** The happy member whose steps drive the loop body. */
  representative: Scenario;
  /** Error assertion target from a negative member, for expect: 'error' cases. */
  errorTarget?: SelectorRecord;
  /** The dataset cases the data file carries (members + rule-derived). */
  cases: DatasetCase[];
}

/** Ordered action signature: what the scenario DOES, ignoring the values. */
function actionSignature(s: Scenario): string {
  return s.steps
    .map((st) => {
      if (st.kind === 'fill') return `fill:${canonicalIntent(st.target.intent)}`;
      if (st.kind === 'click') return `click:${canonicalIntent(st.target.intent)}`;
      if (st.kind === 'press') return `press:${canonicalIntent(st.target.intent)}:${st.key}`;
      if (st.kind === 'select_option') return `select:${canonicalIntent(st.target.intent)}`;
      if (st.kind === 'set_checked') return `check:${canonicalIntent(st.target.intent)}:${st.checked}`;
      return null;
    })
    .filter((x): x is string => x !== null)
    .join('|');
}

/** The fill keys (canonical intents) a scenario's dataset case must cover. */
function fillKeysOf(s: Scenario): string[] {
  const keys = new Set<string>();
  for (const st of s.steps) {
    if (st.kind === 'fill') keys.add(canonicalIntent(st.target.intent));
  }
  return [...keys].sort();
}

/**
 * Decide whether this feature's scenarios support ONE parameterized loop:
 * 2+ scenarios share the same action signature (same fills/clicks, differing
 * values), each has a dataset case, at least one is happy (its steps become
 * the loop body and its assertions the success branch), and error-expect
 * cases have an assertable error target from a negative member. Scenarios
 * outside the group stay individual tests exactly as today.
 */
function buildParamPlan(pc: PageClassPlan, dataset: FeatureDataset): ParamPlan | null {
  const bySig = new Map<string, Scenario[]>();
  for (const s of pc.scenarios) {
    if (fillKeysOf(s).length === 0) continue;
    const sig = actionSignature(s);
    const list = bySig.get(sig) ?? [];
    list.push(s);
    bySig.set(sig, list);
  }
  for (const group of bySig.values()) {
    if (group.length < 2) continue;
    const representative = group.find((s) => s.category === 'happy');
    if (!representative) continue;
    const caseFor = (s: Scenario): DatasetCase | undefined =>
      dataset.cases.find((c) => c.name === s.name || c.name === `boundary: ${s.name}`);
    // Every member's case must cover EVERY fill of that scenario. A gap means
    // the dataset excluded a field (a password, a generated password) — the
    // loop would under-fill the form, so such scenarios stay individual tests
    // where the credential/generator handling applies.
    const covers = (s: Scenario): boolean => {
      const c = caseFor(s);
      if (!c) return false;
      return JSON.stringify(Object.keys(c.values).sort()) === JSON.stringify(fillKeysOf(s));
    };
    if (!group.every(covers)) continue;

    // The data file: the members' cases plus rule-derived cases whose value
    // keys match the group's fill keys (enrichment starts from a member
    // baseline, so key equality selects exactly the compatible cases).
    const groupKeys = JSON.stringify(fillKeysOf(representative));
    const cases = dataset.cases.filter((c) =>
      group.some((s) => caseFor(s) === c) || JSON.stringify(Object.keys(c.values).sort()) === groupKeys,
    );
    if (cases.length < 2) continue;

    let errorTarget: SelectorRecord | undefined;
    for (const s of group) {
      if (s.category !== 'negative') continue;
      for (const st of s.steps) {
        if (st.kind === 'assert' && (st.assertion.type === 'toHaveText' || st.assertion.type === 'toContainText')) {
          errorTarget = st.assertion.target;
          break;
        }
      }
      if (errorTarget) break;
    }
    // error-expect cases with nowhere to assert the error cannot parameterize.
    if (cases.some((c) => c.expect === 'error') && !errorTarget) continue;

    return {
      members: new Set(group),
      representative,
      ...(errorTarget ? { errorTarget } : {}),
      cases,
    };
  }
  return null;
}

/* ───────────────────────── Page grouping ───────────────────────── */

interface PageGroup {
  /** Logical key: feature slug when scenarios have one, else URL-derived. */
  key: string;
  /** Lowercase kebab-case feature slug, e.g. "login" or "forgot-password". */
  feature: string;
  /** Display name for the page (used in PascalCase class name). */
  label: string;
  /** PascalCase class name, e.g. "LoginPage". */
  className: string;
  /** Filename stem for the page-object file (without extension): "login-page". */
  pageFileBase: string;
  /** Folder name under tests/, equals the feature slug: "login". */
  specFolder: string;
  /** The most common first-navigate URL among the feature's scenarios. */
  url: string;
  /**
   * True when every scenario in the feature begins at `url`: the class goto
   * is then the beforeEach. False when the feature spans pages (run 51d535:
   * account spanned /auth/register and /auth/login under one class url, so
   * the login test started on the registration page); each test then opens
   * its own recorded first URL and the beforeEach emits no goto.
   */
  sharedGoto: boolean;
  /** Scenarios whose actions occur primarily on this page. */
  scenarios: Scenario[];
}

interface SelectorUsage {
  /**
   * The locator's identity: the emitted locator call (frame chain included,
   * no .first() wrapper). Two different locators never share a field; the
   * same locator under different intents gets one field.
   */
  identity: string;
  /** Every intent this locator was recorded under, first seen first. */
  intents: string[];
  level: CascadeLevel;
  arg: SelectorRecord['arg'];
  /** iframe-selector chain the element lives behind (outer→inner), if any. */
  frameChain?: string[];
  /**
   * True when ANY occurrence of this intent resolved ambiguously during
   * exploration. The promoted class field must then emit .first(), or the
   * emitted locator trips Playwright strict mode at runtime.
   */
  ambiguous: boolean;
  /** Filter hint that made the locator unique at resolve time, if any. */
  filterText?: string;
  /** Count across all scenarios on this page. */
  uses: number;
}

interface PageClassPlan {
  className: string;
  url: string;
  /** Mirrored from PageGroup: the beforeEach calls goto only when true. */
  sharedGoto: boolean;
  /** Lowercase kebab-case feature slug, mirrored from PageGroup. */
  feature: string;
  /** Filename stem for the page-object file (without extension). */
  pageFileBase: string;
  /** Folder name under tests/. */
  specFolder: string;
  /** Locators promoted to class fields. */
  fields: Array<{ name: string; record: SelectorRecord }>;
  /** Map from a locator's identity (locatorIdentity) to its field name on the class. */
  fieldByIdentity: Map<string, string>;
  /** Synthesized action methods (e.g. loginAs(user, pass)). */
  methods: ActionMethod[];
  /** Scenarios that belong on this page. */
  scenarios: Scenario[];
}

interface ActionMethod {
  /** camelCase method name. */
  name: string;
  /** Ordered list of parameters (typed string). */
  params: Array<{ name: string; type: string }>;
  /** Steps the method replaces, in order. Each refers to a record on the page. */
  steps: TraceStep[];
  /** Original signature for matching when rewriting scenarios. */
  signatureKey: string;
}

function groupScenariosByFeature(report: RunReport): PageGroup[] {
  // Prefer the explicit `feature` tag a scenario carries. Fall back to a
  // URL-pathname derivation when none of the scenarios has a feature (this
  // preserves the legacy grouping behaviour for runs where the Planner
  // didn't tag scenarios — e.g. older traces).
  const groups = new Map<string, PageGroup>();
  for (const scenario of report.scenarios) {
    const url = pickPageUrl(scenario, report.url);
    const feature = (scenario.feature && scenario.feature.trim().length > 0)
      ? scenario.feature.toLowerCase()
      : deriveFeatureFromUrl(url, report.url);
    const key = feature;
    const existing = groups.get(key);
    if (existing) {
      existing.scenarios.push(scenario);
      continue;
    }
    groups.set(key, {
      key,
      feature,
      label: feature.replace(/-/g, ' '),
      className: featureToClassName(feature),
      pageFileBase: `${feature}-page`,
      specFolder: feature,
      url,
      sharedGoto: true,
      scenarios: [scenario],
    });
  }
  // The class url is the most common first URL (ties keep plan order), and
  // the beforeEach goto is shared only when every scenario starts there.
  for (const g of groups.values()) {
    const firsts = g.scenarios.map((s) => pickPageUrl(s, report.url));
    const counts = new Map<string, number>();
    for (const u of firsts) counts.set(u, (counts.get(u) ?? 0) + 1);
    let best = firsts[0]!;
    for (const [u, n] of counts) if (n > (counts.get(best) ?? 0)) best = u;
    g.url = best;
    g.sharedGoto = firsts.every((u) => u === best);
  }
  return [...groups.values()];
}

/** Derive a feature slug from a URL when no explicit tag is present. */
function deriveFeatureFromUrl(url: string, fallbackUrl: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean)[0] ?? '';
    if (seg) {
      const cleaned = seg.toLowerCase()
        .replace(/\.(html?|aspx?|php)$/i, '')
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      if (cleaned) return cleaned;
    }
    // Root path — derive feature from the host's brand name.
    const host = u.host.replace(/^www\./, '').toLowerCase();
    const parts = host.split('.');
    if (parts.length > 1) parts.pop();
    const brand = parts.join('-').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return brand || 'main';
  } catch {
    return deriveFeatureFromUrl(fallbackUrl, '') || 'main';
  }
}

/** "login" → "LoginPage"; "forgot-password" → "ForgotPasswordPage". */
function featureToClassName(feature: string): string {
  const parts = feature.split('-').filter(Boolean);
  if (parts.length === 0) return 'LandingPage';
  const camel = parts.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join('');
  return camel.endsWith('Page') ? camel : camel + 'Page';
}

function pickPageUrl(scenario: Scenario, fallback: string): string {
  for (const step of scenario.steps) {
    if (step.kind === 'navigate') return step.url;
  }
  return fallback;
}

function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.split('/').slice(0, 2).join('/')}`;
  } catch {
    return url;
  }
}

function pageLabel(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean)[0] ?? '';
    if (seg) return seg.replace(/[-_.]+/g, ' ');
    // No path segment, so derive from the host. e.g. www.saucedemo.com → "saucedemo".
    return u.host.replace(/^www\./, '').split('.')[0] ?? u.host;
  } catch {
    return 'page';
  }
}

function pageClassName(url: string): string {
  const raw = pageLabel(url);
  const cleaned = raw.replace(/[^a-zA-Z0-9 ]+/g, ' ').trim();
  const camel = cleaned
    .split(/\s+/)
    .map((w) => w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : '')
    .join('');
  return (camel || 'Landing') + 'Page';
}

/* ───────────────────────── Selector + action analysis ───────────────────────── */

function buildPageClass(group: PageGroup, _lang: 'ts' | 'js'): PageClassPlan {
  // Collect selector usage across all scenarios for this page, keyed by the
  // LOCATOR'S IDENTITY (the emitted call plus frame chain), never by intent.
  // Run 51d535 keyed fields by intent: the model called assert() without
  // one, the tool defaulted it to "element", and every intent-less assertion
  // in a feature collapsed into one field, so a price assertion ran against
  // the page title and a "Thanks" assertion against the error locator.
  const usage = new Map<string, SelectorUsage>();
  for (const scenario of group.scenarios) {
    for (const step of scenario.steps) {
      const target = stepTarget(step);
      if (!target) continue;
      const key = locatorIdentity(target);
      const cur = usage.get(key);
      if (cur) {
        cur.uses += 1;
        if (!cur.intents.includes(target.intent)) cur.intents.push(target.intent);
        // Ambiguity is sticky across occurrences: if the locator EVER resolved
        // to several elements, the shared field needs .first().
        cur.ambiguous = cur.ambiguous || target.ambiguous === true;
      } else {
        usage.set(key, { identity: key, intents: [target.intent], level: target.level, arg: target.arg, frameChain: target.frameChain, ambiguous: target.ambiguous === true, filterText: target.filterText, uses: 1 });
      }
    }
  }

  // Every locator becomes a class field, named by its unique intent when it
  // has one, else by the locator itself (nameFields).
  const fields: PageClassPlan['fields'] = [];
  const fieldByIdentity = nameFields([...usage.values()]);
  for (const u of usage.values()) {
    fields.push({
      name: fieldByIdentity.get(u.identity)!,
      record: { level: u.level, arg: u.arg, intent: u.intents[0]!, frameChain: u.frameChain, ambiguous: u.ambiguous || undefined, filterText: u.filterText },
    });
  }
  // Sort fields by name for stable output.
  fields.sort((a, b) => a.name.localeCompare(b.name));

  const plan: PageClassPlan = {
    className: group.className,
    url: group.url,
    sharedGoto: group.sharedGoto,
    feature: group.feature,
    pageFileBase: group.pageFileBase,
    specFolder: group.specFolder,
    fields,
    fieldByIdentity,
    methods: [],
    scenarios: group.scenarios,
  };
  // Synthesize action methods from common step sequences.
  plan.methods = synthesizeMethods(group.scenarios, plan);
  return plan;
}

/**
 * The identity of a locator for page-object fields: the emitted locator
 * call, frame chain included, without the .first() ambiguity wrapper (which
 * is sticky per field, not part of identity). Exported for the smoke.
 */
export function locatorIdentity(r: SelectorRecord): string {
  return emitLocatorCall(r.level, r.arg, false, r.frameChain, r.filterText);
}

/** The class field a step target is emitted through, if the locator was promoted. */
function fieldFor(pc: PageClassPlan, r: SelectorRecord): string | undefined {
  return pc.fieldByIdentity.get(locatorIdentity(r));
}

/** Intents the tools used to default to; never a field name. */
const PLACEHOLDER_INTENTS = new Set(['element', 'elements', 'target', 're-read element', 'unnamed target']);

/** Names a field can never take: class members of the page object and JS reserved words. */
const RESERVED_FIELD_NAMES = new Set([
  'url', 'page', 'goto', 'expectVisible', 'constructor', 'prototype',
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'static', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'await', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'arguments', 'eval',
]);

/**
 * Name every field. The name comes from the intent when the intent is not a
 * placeholder and names exactly one locator on the page; otherwise from the
 * locator itself (testid or id words, then role and name, then a short css
 * slug); collisions get a numeric suffix as the last resort. Every name is a
 * valid identifier and never a class member or reserved word. Exported for
 * the smoke.
 */
export function nameFields(usages: SelectorUsage[]): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const u of usages) {
    for (const intent of u.intents) {
      const ci = canonicalIntent(intent);
      owners.set(ci, (owners.get(ci) ?? new Set()).add(u.identity));
    }
  }
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const u of usages) {
    let base: string | null = null;
    for (const intent of u.intents) {
      const ci = canonicalIntent(intent);
      if (PLACEHOLDER_INTENTS.has(ci)) continue;
      if ((owners.get(ci)?.size ?? 0) !== 1) continue;
      base = identifierFromIntent(intent);
      break;
    }
    if (!base) base = nameFromLocator(u);
    let name = base;
    if (taken.has(name)) {
      let n = 2;
      while (taken.has(name + n)) n++;
      name = name + n;
    }
    taken.add(name);
    out.set(u.identity, name);
  }
  return out;
}

/** camelCase identifier from words; never empty, never a reserved name, never starting with a digit. */
function identifierFromWords(words: string[]): string {
  const clean = words.map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, '')).filter((w) => w.length > 0);
  let name = clean.map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join('');
  if (!name) name = 'locator';
  if (/^[0-9]/.test(name)) name = '_' + name;
  if (RESERVED_FIELD_NAMES.has(name)) name = name + 'Locator';
  return name;
}

function identifierFromIntent(intent: string): string {
  // username input -> username; login button -> loginButton; error message -> errorMessage
  const words = intent.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const noise = new Set(['input', 'field', 'control']);
  const meaningful = words.filter((w, i) => !(i === words.length - 1 && noise.has(w)));
  return identifierFromWords(meaningful.length > 0 ? meaningful : words);
}

function wordsOf(s: string, max = 4): string[] {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, max);
}

/** A field name from the locator itself, for a locator with no unique non-placeholder intent. */
function nameFromLocator(u: SelectorUsage): string {
  const arg = u.arg;
  const argText = typeof arg === 'string' ? arg : `${(arg as { name?: string }).name ?? ''} ${(arg as { role: string }).role}`;
  switch (u.level) {
    case 'testid':
      return identifierFromWords(wordsOf(argText));
    case 'role': {
      const role = (arg as { role: string; name?: string }).role;
      const name = (arg as { role: string; name?: string }).name ?? '';
      return identifierFromWords([...wordsOf(name), role]);
    }
    case 'label':
    case 'placeholder':
      return identifierFromWords(wordsOf(argText));
    case 'text':
      return identifierFromWords([...wordsOf(argText), 'text']);
    case 'alt':
      return identifierFromWords([...wordsOf(argText), 'image']);
    case 'title':
      return identifierFromWords([...wordsOf(argText), 'title']);
    case 'xpath':
      return identifierFromWords(['xpath', ...wordsOf(argText, 3)]);
    case 'css':
    default: {
      // testid or id words first, then a short slug of the selector's words.
      const testid = argText.match(/\[data-test(?:id)?\s*[\^$*]?=\s*["']?([A-Za-z0-9_-]+)/);
      if (testid) return identifierFromWords(wordsOf(testid[1]!));
      const id = argText.match(/#([A-Za-z0-9_-]+)/);
      if (id) return identifierFromWords(wordsOf(id[1]!));
      const slug = argText.replace(/::?[a-z-]+(\([^)]*\))?/g, ' ').replace(/\[[^\]]*\]/g, ' ');
      return identifierFromWords(wordsOf(slug));
    }
  }
}

/**
 * Normalize an intent string for dedup. Lowercases, strips trailing noise words
 * (input/field/control), and squashes whitespace. So "Username", "username",
 * "Username Input", and "username field" all become the same key.
 */
export function canonicalIntent(intent: string): string {
  const NOISE = new Set(['input', 'field', 'control', 'box', 'the', 'a', 'an']);
  return intent
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NOISE.has(w))
    .join(' ')
    .trim() || intent.toLowerCase().trim();
}

/** RHS expression for a capture/compare read, emitted inline. */
function captureRhs(source: CaptureSource, target: SelectorRecord, attribute?: string): string {
  if (source === 'count') {
    return `await ${emitLocatorCall(target.level, target.arg, false, target.frameChain, target.filterText)}.count()`;
  }
  const locFirst = emitLocatorCall(target.level, target.arg, true, target.frameChain, target.filterText);
  if (source === 'attribute') return `(await ${locFirst}.getAttribute(${q(attribute!)}))?.trim() ?? ''`;
  return `(await ${locFirst}.textContent())?.trim() ?? ''`;
}

function stepTarget(step: TraceStep): SelectorRecord | null {
  if (step.kind === 'click' || step.kind === 'fill' || step.kind === 'press') return step.target;
  if (step.kind === 'select_option' || step.kind === 'set_checked' || step.kind === 'set_input_files') return step.target;
  if (step.kind === 'assert') {
    const a = step.assertion;
    if ('target' in a) return a.target;
  }
  if (step.kind === 'wait_for_state') return step.target;
  return null;
}

/**
 * Look for a "fill + fill + click" sequence that appears at the top of 2+
 * scenarios. When found, synthesize a single action method. This handles the
 * canonical login flow cleanly without trying to be too clever for v1.
 */
function synthesizeMethods(scenarios: Scenario[], pc: PageClassPlan): ActionMethod[] {
  const methods: ActionMethod[] = [];
  const seenSignatures = new Set<string>();

  for (const scenario of scenarios) {
    // Find leading sequence of fill/click steps for this scenario.
    const lead: TraceStep[] = [];
    for (const step of scenario.steps) {
      if (step.kind === 'navigate' || step.kind === 'wait' || step.kind === 'stability_wait' || step.kind === 'checkpoint') continue;
      if (step.kind === 'fill' || step.kind === 'click' || step.kind === 'press') {
        lead.push(step);
      } else break;
    }
    // We only synthesize when there are 2+ steps (a meaningful sequence) and at
    // least one fill (so it carries data).
    if (lead.length < 2 || !lead.some((s) => s.kind === 'fill')) continue;

    const sig = lead.map(stepSignature).join('|');
    if (seenSignatures.has(sig)) continue;

    // Does this signature appear in another scenario?
    let occurrences = 0;
    for (const other of scenarios) {
      const otherLead: TraceStep[] = [];
      for (const step of other.steps) {
        if (step.kind === 'navigate' || step.kind === 'wait' || step.kind === 'stability_wait' || step.kind === 'checkpoint') continue;
        if (step.kind === 'fill' || step.kind === 'click' || step.kind === 'press') otherLead.push(step);
        else break;
      }
      const otherSig = otherLead.map(stepSignature).join('|');
      if (otherSig === sig) occurrences++;
    }
    if (occurrences < 2) continue;

    seenSignatures.add(sig);
    methods.push(buildMethodFromLead(lead, pc, sig));
  }

  return methods;
}

/** A step's action signature keys on the LOCATOR, so two fields never share a method slot. */
function stepSignature(step: TraceStep): string {
  if (step.kind === 'fill')  return `fill:${locatorIdentity(step.target)}`;
  if (step.kind === 'click') return `click:${locatorIdentity(step.target)}`;
  if (step.kind === 'press') return `press:${locatorIdentity(step.target)}:${step.key}`;
  return '';
}

function buildMethodFromLead(lead: TraceStep[], pc: PageClassPlan, signatureKey: string): ActionMethod {
  // Derive a method name from the leading sequence.
  // Heuristic: if there are 2 fills + 1 click, name it after the click target
  // (most often "login button" → loginAs). Otherwise, "<click intent>".
  const fills = lead.filter((s) => s.kind === 'fill');
  const click = lead.find((s) => s.kind === 'click');
  let methodName = 'submit';
  if (click && click.kind === 'click') {
    const word = canonicalIntent(click.target.intent).replace(/\bbutton\b|\blink\b/g, '').trim().split(/\s+/)[0] ?? 'submit';
    methodName = word + (fills.length >= 2 ? 'As' : '');
  }

  // Parameters: one per fill, named after the field (deduped).
  const params: ActionMethod['params'] = [];
  const usedNames = new Set<string>();
  for (const f of fills) {
    if (f.kind !== 'fill') continue;
    let p = (fieldFor(pc, f.target) || 'value').replace(/^the_?/, '');
    if (usedNames.has(p)) {
      let n = 2; while (usedNames.has(p + n)) n++;
      p = p + n;
    }
    usedNames.add(p);
    params.push({ name: p, type: 'string' });
  }

  return { name: methodName, params, steps: lead, signatureKey };
}

/* ───────────────────────── Emit ───────────────────────── */

function renderBasePage(ext: 'ts' | 'js'): string {
  if (ext === 'ts') {
    return [
      `import { type Page, expect } from '@playwright/test';`,
      ``,
      `/** Base class for every page object. Shared navigation + wait helpers. */`,
      `export abstract class BasePage {`,
      `  protected constructor(protected readonly page: Page) {}`,
      `  abstract readonly url: string;`,
      ``,
      `  async goto(): Promise<void> {`,
      `    await this.page.goto(this.url, { waitUntil: 'domcontentloaded' });`,
      `  }`,
      ``,
      `  async expectVisible(locator: import('@playwright/test').Locator): Promise<void> {`,
      `    await expect(locator).toBeVisible();`,
      `  }`,
      `}`,
      ``,
    ].join('\n');
  }
  return [
    `const { expect } = require('@playwright/test');`,
    ``,
    `class BasePage {`,
    `  constructor(page) {`,
    `    this.page = page;`,
    `  }`,
    `  async goto() {`,
    `    await this.page.goto(this.url, { waitUntil: 'domcontentloaded' });`,
    `  }`,
    `  async expectVisible(locator) {`,
    `    await expect(locator).toBeVisible();`,
    `  }`,
    `}`,
    `module.exports = { BasePage };`,
    ``,
  ].join('\n');
}

function renderPageClass(plan: PageClassPlan, ext: 'ts' | 'js'): string {
  if (ext === 'ts') {
    const out: string[] = [];
    out.push(`import { type Page, type Locator } from '@playwright/test';`);
    out.push(`import { BasePage } from './BasePage';`);
    out.push(``);
    out.push(`/** Page object for ${q(plan.url)}. Auto-generated from a verified browser session. */`);
    out.push(`export class ${plan.className} extends BasePage {`);
    out.push(`  readonly url = ${q(plan.url)};`);
    for (const f of plan.fields) {
      out.push(`  readonly ${f.name}: Locator;`);
    }
    out.push(``);
    out.push(`  constructor(page: Page) {`);
    out.push(`    super(page);`);
    for (const f of plan.fields) {
      out.push(`    this.${f.name} = ${emitLocatorCall(f.record.level, f.record.arg, f.record.ambiguous === true, f.record.frameChain, f.record.filterText)};`);
    }
    out.push(`  }`);
    for (const m of plan.methods) {
      out.push(``);
      out.push(...emitMethod(m, plan, ext).map((l) => '  ' + l));
    }
    out.push(`}`);
    out.push(``);
    return out.join('\n');
  }
  // JS variant
  const out: string[] = [];
  out.push(`const { BasePage } = require('./BasePage');`);
  out.push(``);
  out.push(`class ${plan.className} extends BasePage {`);
  out.push(`  constructor(page) {`);
  out.push(`    super(page);`);
  out.push(`    this.url = ${q(plan.url)};`);
  for (const f of plan.fields) {
    out.push(`    this.${f.name} = ${emitLocatorCall(f.record.level, f.record.arg, f.record.ambiguous === true, f.record.frameChain, f.record.filterText)};`);
  }
  out.push(`  }`);
  for (const m of plan.methods) {
    out.push(``);
    out.push(...emitMethod(m, plan, ext).map((l) => '  ' + l));
  }
  out.push(`}`);
  out.push(`module.exports = { ${plan.className} };`);
  out.push(``);
  return out.join('\n');
}

function emitMethod(method: ActionMethod, pc: PageClassPlan, ext: 'ts' | 'js'): string[] {
  const paramList = method.params.map((p) => ext === 'ts' ? `${p.name}: ${p.type}` : p.name).join(', ');
  const sig = ext === 'ts'
    ? `async ${method.name}(${paramList}): Promise<void> {`
    : `async ${method.name}(${paramList}) {`;
  const body: string[] = [];
  let paramIdx = 0;
  for (const step of method.steps) {
    if (step.kind === 'fill') {
      const field = fieldFor(pc, step.target);
      const valueArg = method.params[paramIdx]?.name ?? q(step.value);
      paramIdx++;
      body.push(field
        ? `await this.${field}.fill(${valueArg});`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain, step.target.filterText)}.fill(${valueArg});`);
    } else if (step.kind === 'click') {
      const field = fieldFor(pc, step.target);
      body.push(field
        ? `await this.${field}.click();`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain, step.target.filterText)}.click();`);
    } else if (step.kind === 'press') {
      const field = fieldFor(pc, step.target);
      body.push(field
        ? `await this.${field}.press(${q(step.key)});`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain, step.target.filterText)}.press(${q(step.key)});`);
    }
  }
  return [sig, ...body.map((l) => '  ' + l), `}`];
}

function renderSpec(
  report: RunReport,
  pc: PageClassPlan,
  ext: 'ts' | 'js',
  extras: { param?: ParamPlan | undefined; authActive?: boolean; authCreds?: AuthCredentials | null } = {},
): string {
  // Spec lives at tests/<feature>/<feature>.spec.{ext} — two levels deep from
  // the framework root, so the page-object import path is `../../pages/...`.
  const importPath = `../../pages/${pc.pageFileBase}`;
  const handle = camelize(pc.className);
  const describeTitle = `${titleFromUrl(report.url)} / ${pc.feature}`;
  const param = extras.param;
  const authActive = extras.authActive === true;
  // Fills whose VALUE equals the happy login's credentials become env
  // references, and only in the login spec of an auth-enabled framework (the
  // setup file covers the rest of the tree). Wrong-credential values are test
  // data and stay literal.
  const creds = authActive && pc.feature === 'login' ? extras.authCreds ?? null : null;
  const out: string[] = [];
  // Generated fields (registration email, unique username) call uniqueEmail() /
  // uniqueToken() at the spec call site, so import whichever ones this spec uses.
  const genKinds = new Set<GenerateKind>();
  for (const sc of pc.scenarios) {
    for (const st of sc.steps) {
      if (st.kind === 'fill' && st.generate) genKinds.add(st.generate);
    }
  }
  const genFns = [...genKinds].map(uniqueFnName).sort();
  // A numeric compare (greater / less) reads "$1,299.00" through the shipped
  // helpers/parse-number, the same parser the agent verified with.
  const usesNumeric = pc.scenarios.some((sc) => sc.steps.some((st) => st.kind === 'assert_compare' && (st.relation === 'greater' || st.relation === 'less')));
  if (ext === 'ts') {
    out.push(`import { test, expect } from '@playwright/test';`);
    out.push(`import { ${pc.className} } from '${importPath}';`);
    if (genFns.length > 0) out.push(`import { ${genFns.join(', ')} } from '../../helpers/unique-data';`);
    if (usesNumeric) out.push(`import { parseNumber } from '../../helpers/parse-number';`);
    if (param) out.push(`import rawCases from '../../data/${pc.feature}.json';`);
  } else {
    out.push(`const { test, expect } = require('@playwright/test');`);
    out.push(`const { ${pc.className} } = require('${importPath}');`);
    if (genFns.length > 0) out.push(`const { ${genFns.join(', ')} } = require('../../helpers/unique-data');`);
    if (usesNumeric) out.push(`const { parseNumber } = require('../../helpers/parse-number');`);
    if (param) out.push(`const rawCases = require('../../data/${pc.feature}.json');`);
  }
  out.push(``);
  out.push(`/* Auto-generated by QA-Core. Source URL: ${report.url}`);
  out.push(` * Feature: ${pc.feature}`);
  out.push(` * Verified live before transcription.`);
  out.push(` */`);
  out.push(``);
  if (param) {
    // The dataset the loop below iterates. Extend it by hand: add a case to
    // data/<feature>.json and the suite grows without touching this file.
    if (ext === 'ts') {
      out.push(`type DataCase = { name: string; values: Record<string, string>; expect: string; errorText?: string; ruleIds?: string[] };`);
      out.push(`const dataCases = rawCases as unknown as DataCase[];`);
    } else {
      out.push(`/** @type {Array<{ name: string, values: Record<string, string>, expect: string, errorText?: string, ruleIds?: string[] }>} */`);
      out.push(`const dataCases = rawCases;`);
    }
    out.push(renderResolveData(genFns, ext));
    out.push(``);
  }
  out.push(`test.describe(${q(describeTitle)}, () => {`);

  if (ext === 'ts') {
    out.push(`  let ${handle}: ${pc.className};`);
  } else {
    out.push(`  let ${handle};`);
  }
  out.push('');
  out.push(`  test.beforeEach(async ({ context, page }) => {`);
  if (authActive && pc.feature !== 'login') {
    // Authenticated specs run on the saved storageState session. Clearing
    // cookies here would destroy exactly the state the setup project built.
    out.push(`    // Session comes from playwright/.auth/user.json (the setup project); do not clear it.`);
  } else {
    // Per-test isolation: matches the agent's exploration-time isolation.
    out.push(`    await context.clearCookies();`);
    out.push(`    try { await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); } catch { /* about:blank */ }`);
  }
  out.push(`    ${handle} = new ${pc.className}(page);`);
  if (pc.sharedGoto) {
    out.push(`    await ${handle}.goto();`);
  } else {
    // The feature spans pages: each test opens its own recorded first URL.
    out.push(`    // Scenarios in this feature start on different pages; each test opens its own.`);
  }
  out.push(`  });`);
  out.push('');

  for (const scenario of pc.scenarios) {
    if (param?.members.has(scenario)) continue; // collapsed into the data loop
    out.push(...renderScenario(scenario, pc, ext, creds, report.url).map((l) => '  ' + l));
    out.push('');
  }

  if (param) {
    out.push(...renderParamLoop(param, pc, ext).map((l) => '  ' + l));
    out.push('');
  }

  out.push(`});`);
  out.push('');
  return out.join('\n');
}

/** The marker resolver a parameterized spec uses for generated-unique values. */
function renderResolveData(genFns: string[], ext: 'ts' | 'js'): string {
  const branches: string[] = [];
  if (genFns.includes('uniqueEmail')) branches.push(`v === '{{uniqueEmail}}' ? uniqueEmail() :`);
  if (genFns.includes('uniqueToken')) branches.push(`v === '{{uniqueToken}}' ? uniqueToken() :`);
  const sig = ext === 'ts' ? '(v: string): string' : '(v)';
  return `const resolveData = ${sig} => ${branches.length > 0 ? branches.join(' ') + ' v' : 'v'};`;
}

/**
 * The one data-driven test loop: the happy representative's steps drive the
 * page, fills take their values from the case, and the closing assertion
 * follows c.expect — the representative's own success assertions, or the
 * recorded error locator with c.errorText.
 */
function renderParamLoop(param: ParamPlan, pc: PageClassPlan, ext: 'ts' | 'js'): string[] {
  const handle = camelize(pc.className);
  const rep = param.representative;
  const out: string[] = [];
  out.push(`for (const c of dataCases) {`);
  out.push(`  test(\`[data] ${pc.feature} — \${c.name}\`, async ({ page }) => {`);

  // Action steps from the representative, fills parameterized by the case.
  // The first navigate is the beforeEach goto only when the feature shares
  // one; a multi-page feature keeps it as the test's own goto.
  let initialNavSkipped = !pc.sharedGoto;
  const actions: string[] = [];
  const closing: string[] = [];
  let pastActions = false;
  for (const step of rep.steps) {
    if (step.kind === 'navigate') {
      if (!initialNavSkipped) { initialNavSkipped = true; continue; }
      (pastActions ? closing : actions).push(`await page.goto(${q(step.url)});`);
      continue;
    }
    if (step.kind === 'wait' || step.kind === 'stability_wait' || step.kind === 'checkpoint') continue;
    if (step.kind === 'fill') {
      const key = canonicalIntent(step.target.intent);
      const field = fieldFor(pc, step.target);
      const valueArg = `resolveData(c.values[${q(key)}] ?? '')`;
      actions.push(field
        ? `await ${handle}.${field}.fill(${valueArg});`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain, step.target.filterText)}.fill(${valueArg});`);
      continue;
    }
    if (step.kind === 'click' || step.kind === 'press' || step.kind === 'select_option' || step.kind === 'set_checked' || step.kind === 'set_input_files') {
      actions.push(...emitStepCall(step, pc, handle));
      continue;
    }
    // Everything after the last action is the success-path closing sequence
    // (assertions, captures, compares).
    pastActions = true;
    closing.push(...emitStepCall(step, pc, handle));
  }

  for (const line of actions) out.push(`    ${line}`);
  const errorField = param.errorTarget ? fieldFor(pc, param.errorTarget) : undefined;
  const errorLocExpr = param.errorTarget
    ? (errorField
        ? `${handle}.${errorField}`
        : emitLocatorCall(param.errorTarget.level, param.errorTarget.arg, param.errorTarget.ambiguous === true, param.errorTarget.frameChain, param.errorTarget.filterText))
    : null;
  if (errorLocExpr) {
    out.push(`    if (c.expect === 'error') {`);
    out.push(`      await expect(${errorLocExpr}).toContainText(c.errorText ?? '', { timeout: ${COMPARE_POLL_TIMEOUT_MS} });`);
    out.push(`    } else {`);
    for (const line of closing) out.push(`      ${line}`);
    out.push(`    }`);
  } else {
    for (const line of closing) out.push(`    ${line}`);
  }
  out.push(`  });`);
  out.push(`}`);
  return out;
}

function renderScenario(scenario: Scenario, pc: PageClassPlan, ext: 'ts' | 'js', creds: AuthCredentials | null = null, fallbackUrl: string = pc.url): string[] {
  const handle = camelize(pc.className);
  const tag = scenario.category === 'happy' ? '[happy]'
            : scenario.category === 'negative' ? '[negative]'
            : scenario.category === 'edge' ? '[edge]'
            : '[a11y]';
  const out: string[] = [];
  out.push(`test(${q(tag + ' ' + scenario.name)}, async ({ page }) => {`);

  // Try to match the leading steps to a synthesized method.
  const lead: TraceStep[] = [];
  for (const step of scenario.steps) {
    if (step.kind === 'navigate' || step.kind === 'wait' || step.kind === 'stability_wait' || step.kind === 'checkpoint') continue;
    if (step.kind === 'fill' || step.kind === 'click' || step.kind === 'press') lead.push(step);
    else break;
  }
  const leadSig = lead.map(stepSignature).join('|');
  const matched = pc.methods.find((m) => m.signatureKey === leadSig);

  const consumed = new Set<TraceStep>();
  if (matched) {
    // Emit the action method call with the fill values as arguments.
    const fillValues = matched.steps
      .filter((s): s is Extract<TraceStep, { kind: 'fill' }> => s.kind === 'fill')
      .map((s) => {
        // Find the corresponding step in THIS scenario (same locator) to use its actual value.
        const real = scenario.steps.find((x) => x.kind === 'fill' && locatorIdentity(x.target) === locatorIdentity(s.target));
        const realFill = (real && real.kind === 'fill') ? real : s;
        // The REAL credentials in an auth-enabled login spec come from env,
        // never a literal (value-based match); a generated field passes a
        // fresh value on every run.
        const env = creds ? envForCredentialValue(realFill.value, creds) : null;
        if (env) return `process.env.${env} ?? ''`;
        return realFill.generate ? uniqueCallExpr(realFill.generate) : q(realFill.value);
      });
    out.push(`  await ${handle}.${matched.name}(${fillValues.join(', ')});`);
    // Mark the lead steps consumed so we don't re-emit them below.
    for (const step of lead) consumed.add(step);
  }

  // When the feature shares one first URL, the beforeEach already navigates
  // there, so the scenario's FIRST navigate is redundant and dropped. Every
  // LATER navigate is load-bearing (a reload, or a move to another URL): a
  // capture-and-compare scenario that captures a value, reloads, then asserts
  // it changed needs that reload in the emitted spec, or the test re-reads the
  // same page and can never go red. A multi-page feature has no shared goto:
  // the first navigate is kept, and a scenario with none opens its page here.
  let initialNavSkipped = !pc.sharedGoto;
  if (!pc.sharedGoto && !scenario.steps.some((s) => s.kind === 'navigate')) {
    out.push(`  await page.goto(${q(fallbackUrl)});`);
  }
  for (const step of scenario.steps) {
    if (consumed.has(step)) continue;
    if (step.kind === 'navigate') {
      if (!initialNavSkipped) { initialNavSkipped = true; continue; }
      out.push(`  await page.goto(${q(step.url)});`);
      continue;
    }
    for (const line of emitStepCall(step, pc, handle, creds)) {
      out.push('  ' + line);
    }
  }
  out.push(`});`);
  return out;
}

function emitStepCall(step: TraceStep, pc: PageClassPlan, handle: string, creds: AuthCredentials | null = null): string[] {
  switch (step.kind) {
    case 'click': {
      const field = fieldFor(pc, step.target);
      return [field
        ? `await ${handle}.${field}.click();`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain, step.target.filterText)}.click();`];
    }
    case 'fill': {
      const field = fieldFor(pc, step.target);
      const env = creds ? envForCredentialValue(step.value, creds) : null;
      const valueArg = env ? `process.env.${env} ?? ''` : step.generate ? uniqueCallExpr(step.generate) : q(step.value);
      return [field
        ? `await ${handle}.${field}.fill(${valueArg});`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain, step.target.filterText)}.fill(${valueArg});`];
    }
    case 'press': {
      const field = fieldFor(pc, step.target);
      return [field
        ? `await ${handle}.${field}.press(${q(step.key)});`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain, step.target.filterText)}.press(${q(step.key)});`];
    }
    case 'select_option': {
      const field = fieldFor(pc, step.target);
      const base = field ? `${handle}.${field}` : emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain, step.target.filterText);
      return [`await ${base}.${selectOptionExpr(step.by, step.option)};`];
    }
    case 'set_checked': {
      const field = fieldFor(pc, step.target);
      const base = field ? `${handle}.${field}` : emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain, step.target.filterText);
      return [`await ${base}.${step.checked ? 'check' : 'uncheck'}();`];
    }
    case 'set_input_files': {
      const field = fieldFor(pc, step.target);
      const base = field ? `${handle}.${field}` : emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain, step.target.filterText);
      return [`await ${base}.setInputFiles(${filesArg(step.files)});`];
    }
    case 'wait':
      return [`await page.waitForTimeout(${step.ms});`];
    case 'stability_wait':
      return [`await page.waitForTimeout(${step.ms}); // stability comparison wait`];
    case 'checkpoint':
      return [`// ${step.label}`];
    case 'assert':
      return [emitAssertion(step.assertion, pc, handle)];
    case 'navigate':
      return [`await page.goto(${q(step.url)});`];
    case 'capture': {
      // Capture-and-compare emits inline locators (no page-object field): the
      // read needs .first() for attribute/text and the full multi-match locator
      // for count, neither of which the field handle exposes cleanly.
      return [`const ${step.varName} = ${captureRhs(step.source, step.target, step.attribute)}; // captured ${step.source} for compare`];
    }
    case 'assert_compare': {
      if (step.relation === 'absent') {
        if (step.source === 'attribute' && step.attribute) {
          return ['await expect(page.locator(`[' + step.attribute + '="${' + step.varName + '}"]`)).toHaveCount(0);'];
        }
        return [`await expect(page.getByText(${step.varName}, { exact: true })).toHaveCount(0);`];
      }
      // Poll the after-action read with expect.poll, not a one-shot const read.
      // A sort or re-render settles asynchronously, so a single read races it and
      // flakes. expect.poll re-reads until the relation holds or the timeout
      // expires, the web-first wait Playwright already uses for locators.
      // The re-read element is the compare's own target when it named one.
      const readRhs = captureRhs(step.source, step.readTarget ?? step.target, step.attribute);
      const pollOpts = `{ timeout: ${COMPARE_POLL_TIMEOUT_MS} }`;
      const lines: string[] = [];
      switch (step.relation) {
        case 'changed':
          lines.push(`await expect.poll(async () => ${readRhs}, ${pollOpts}).not.toBe(${step.varName}); // value changed after the action`);
          break;
        case 'unchanged':
        case 'equal':
          lines.push(`await expect.poll(async () => ${readRhs}, ${pollOpts}).toBe(${step.varName}); // value held`);
          if (step.bounds) {
            const locFirst = emitLocatorCall(step.target.level, step.target.arg, true, step.target.frameChain, step.target.filterText);
            lines.push(
              `const ${step.readVar}Now = Number(${readRhs});`,
              `const ${step.readVar}Min = Number(await ${locFirst}.getAttribute(${q(step.bounds.min)}));`,
              `const ${step.readVar}Max = Number(await ${locFirst}.getAttribute(${q(step.bounds.max)}));`,
              `expect(${step.readVar}Now).toBeGreaterThan(${step.readVar}Min);`,
              `expect(${step.readVar}Now).toBeLessThan(${step.readVar}Max);`,
            );
          }
          break;
        case 'greater':
          lines.push(`await expect.poll(async () => parseNumber(${readRhs}), ${pollOpts}).toBeGreaterThan(parseNumber(${step.varName}));`);
          break;
        case 'less':
          lines.push(`await expect.poll(async () => parseNumber(${readRhs}), ${pollOpts}).toBeLessThan(parseNumber(${step.varName}));`);
          break;
        case 'before':
          lines.push(`await expect.poll(async () => String(${readRhs}).localeCompare(${step.varName}), ${pollOpts}).toBeLessThan(0); // sorts before the captured value`);
          break;
        case 'after':
          lines.push(`await expect.poll(async () => String(${readRhs}).localeCompare(${step.varName}), ${pollOpts}).toBeGreaterThan(0); // sorts after the captured value`);
          break;
      }
      return lines;
    }
    case 'wait_for_state': {
      const field = fieldFor(pc, step.target);
      const locExpr = field
        ? `${handle}.${field}`
        : emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain, step.target.filterText);
      return [`await ${locExpr}.waitFor({ state: '${step.state}' });`];
    }
  }
}

function emitAssertion(a: Assertion, pc: PageClassPlan, handle: string): string {
  switch (a.type) {
    case 'toBeVisible': {
      const field = fieldFor(pc, a.target);
      const loc = field ? `${handle}.${field}` : emitLocatorCall(a.target.level, a.target.arg, a.target.ambiguous === true, a.target.frameChain, a.target.filterText);
      const opts = a.timeout ? `{ timeout: ${a.timeout} }` : '';
      return `await expect(${loc}).toBeVisible(${opts});`;
    }
    case 'toHaveText':
    case 'toContainText': {
      const field = fieldFor(pc, a.target);
      const loc = field ? `${handle}.${field}` : emitLocatorCall(a.target.level, a.target.arg, a.target.ambiguous === true, a.target.frameChain, a.target.filterText);
      const fn = a.type === 'toHaveText' ? 'toHaveText' : 'toContainText';
      const opts = a.timeout ? `, { timeout: ${a.timeout} }` : '';
      return `await expect(${loc}).${fn}(${a.pattern ? regexLiteral(a.pattern) : q(a.text)}${opts});`;
    }
    case 'toBeChecked': {
      const field = fieldFor(pc, a.target);
      const loc = field ? `${handle}.${field}` : emitLocatorCall(a.target.level, a.target.arg, a.target.ambiguous === true, a.target.frameChain, a.target.filterText);
      const opts = [a.checked ? '' : 'checked: false', a.timeout ? `timeout: ${a.timeout}` : ''].filter(Boolean).join(', ');
      return `await expect(${loc}).toBeChecked(${opts ? `{ ${opts} }` : ''});`;
    }
    case 'toHaveURL': {
      const opts = a.timeout ? `, { timeout: ${a.timeout} }` : '';
      return `await expect(page).toHaveURL(new RegExp(${q(a.pattern)})${opts});`;
    }
    case 'toBeHidden': {
      // Absence assertion. Force .first() so a selector matching several hidden
      // nodes (or none) never trips strict mode. An absent element has no page
      // object field, so always emit the inline locator.
      const loc = emitLocatorCall(a.target.level, a.target.arg, true, a.target.frameChain, a.target.filterText);
      const opts = a.timeout ? `{ timeout: ${a.timeout} }` : '';
      return `await expect(${loc}).toBeHidden(${opts});`;
    }
    case 'toHaveCount': {
      // toHaveCount needs the multi-match locator (invariant: a count check is
      // meaningless after .first()). A field whose intent was ever ambiguous
      // now emits .first(), so bypass it and emit the bare locator inline.
      const field = fieldFor(pc, a.target);
      const fieldRec = field ? pc.fields.find((f) => f.name === field)?.record : undefined;
      const loc = field && fieldRec && fieldRec.ambiguous !== true
        ? `${handle}.${field}`
        : emitLocatorCall(a.target.level, a.target.arg, false, a.target.frameChain, a.target.filterText);
      if (a.atLeast) {
        // A minimum, polled: Playwright has no toHaveCount matcher for "at least".
        return `await expect.poll(async () => ${loc}.count(), { timeout: ${a.timeout ?? COMPARE_POLL_TIMEOUT_MS} }).toBeGreaterThanOrEqual(${a.count}); // at least ${a.count}`;
      }
      const opts = a.timeout ? `, { timeout: ${a.timeout} }` : '';
      return `await expect(${loc}).toHaveCount(${a.count}${opts});`;
    }
    case 'toHaveAttribute': {
      const field = fieldFor(pc, a.target);
      const loc = field ? `${handle}.${field}` : emitLocatorCall(a.target.level, a.target.arg, a.target.ambiguous === true, a.target.frameChain, a.target.filterText);
      const opts = a.timeout ? `, { timeout: ${a.timeout} }` : '';
      return `await expect(${loc}).toHaveAttribute(${q(a.attribute)}, ${a.pattern ? regexLiteral(a.pattern) : q(a.value)}${opts});`;
    }
    case 'toHaveValue': {
      const field = fieldFor(pc, a.target);
      const loc = field ? `${handle}.${field}` : emitLocatorCall(a.target.level, a.target.arg, a.target.ambiguous === true, a.target.frameChain, a.target.filterText);
      const opts = a.timeout ? `, { timeout: ${a.timeout} }` : '';
      return `await expect(${loc}).toHaveValue(${q(a.value)}${opts});`;
    }
  }
}

function renderA11ySpec(url: string, ext: 'ts' | 'js'): string {
  const out: string[] = [];
  if (ext === 'ts') {
    out.push(`import { test, expect } from '@playwright/test';`);
    out.push(`import AxeBuilder from '@axe-core/playwright';`);
  } else {
    out.push(`const { test, expect } = require('@playwright/test');`);
    out.push(`const AxeBuilder = require('@axe-core/playwright').default;`);
  }
  out.push('');
  out.push(`test('a11y: landing page has no critical/serious WCAG 2 AA violations', async ({ page }) => {`);
  out.push(`  await page.goto(${q(url)});`);
  out.push(`  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();`);
  out.push(`  const blocking = results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');`);
  out.push(`  if (blocking.length) console.error('a11y blocking violations:\\n' + JSON.stringify(blocking, null, 2));`);
  out.push(`  expect(blocking).toEqual([]);`);
  out.push(`});`);
  out.push('');
  return out.join('\n');
}

/* ───────────────────────── helpers ───────────────────────── */

function camelize(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return `QA-Core: ${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return `QA-Core: ${url}`;
  }
}

function q(s: string): string {
  return JSON.stringify(s);
}
