/**
 * Locks dataset error cases (invariant 77, run 59540f D7b).
 *
 * Run 7's R14 data case ("rejected an email address without an @ sign")
 * shipped as toContainText(c.errorText ?? '') with no errorText: its
 * recording asserted the email error visible and matching /[Ee]mail|valid|
 * invalid/, the dataset kept only a literal text, and the loop asserted the
 * empty string on the error element. It also selected the happy case's
 * subject "customer-service" where the recording chose "warranty".
 *
 * A fixture contact form has two error cases on DIFFERENT error elements
 * (the email error with a pattern, the message error with a literal) and
 * three different subject values.
 *   A. the data file: each error case carries its own checks (visibility,
 *      the pattern with its flags, or the literal) on its own element, and
 *      every case its own select value; the spec selects through dataSelect
 *      and asserts through expectDataErrors; no emitted file asserts an
 *      empty text.
 *   B. BEHAVIOR, TS and JS: the emitted framework runs green; with the
 *      fixture's email error text changed so it no longer matches the
 *      pattern, the email data case FAILS and the other two still pass.
 *   C. a case whose error assertion or select value cannot be carried is
 *      left out of the data file with one note naming it and why, and ships
 *      as its own test; a rule-derived error case is left out, not emitted.
 *   D. the rule 2 guard: an empty toHaveText / toContainText throws a named
 *      error in both emitters and both languages, and the tool refuses one.
 *   E. an empty or whitespace pattern counts as empty: the data file writer
 *      and the recorded-check reader refuse it, and the emitted guard throws
 *      at run time on a hand-edited data file (TS and JS).
 * No network beyond 127.0.0.1, no model call.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { scaffold } from '../src/agent/scaffold.js';
import { transcribe, EmptyTextExpectationError } from '../src/agent/transcriber.js';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import type { RunReport, Scenario, SelectorRecord, TraceStep } from '../src/agent/trace.js';
import type { RequirementsMap } from '../src/agent/requirements.js';
import { renderDatasetJson, recordedErrorChecks } from '../src/agent/datasets.js';
import { emitFramework, emptyTextHits, runPlaywright, cleanup, type Emitted } from './lib/emitted-runner.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

/* ─── the fixture site ─────────────────────────────────────────────────── */
const EMAIL_ERROR_MATCHING = 'Email format is invalid';
const EMAIL_ERROR_CHANGED = 'Please check this field';
let emailError = EMAIL_ERROR_MATCHING;
const contactPage = (): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Contact</title></head><body><main>
<h1>Contact</h1>
<form id="f" novalidate>
  <label for="first_name">First name</label><input id="first_name" type="text">
  <label for="email">Email</label><input id="email" type="text"><div id="email_alert" hidden></div>
  <label for="subject">Subject</label><select id="subject"><option value="">Select a subject</option><option value="customer-service">Customer service</option><option value="warranty">Warranty</option><option value="payments">Payments</option></select>
  <label for="message">Message</label><textarea id="message"></textarea><div id="message_alert" hidden></div>
  <input type="submit" value="Send">
</form>
<div id="thanks" role="alert" hidden>Thanks for your message!</div>
<script>
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const message = document.getElementById('message').value;
  const subject = document.getElementById('subject').value;
  const ea = document.getElementById('email_alert');
  const ma = document.getElementById('message_alert');
  ea.hidden = true; ma.hidden = true;
  let ok = !!subject;
  if (!email.includes('@')) { ea.textContent = ${JSON.stringify(emailError)}; ea.hidden = false; ok = false; }
  if (message.trim().length < 5) { ma.textContent = 'Message is required'; ma.hidden = false; ok = false; }
  if (ok) { document.getElementById('f').hidden = true; document.getElementById('thanks').hidden = false; }
});
</script></main></body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(contactPage());
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/* ─── the recorded scenarios ───────────────────────────────────────────── */
const label = (arg: string, intent: string): SelectorRecord => ({ level: 'label', arg, intent });
const css = (arg: string, intent: string): SelectorRecord => ({ level: 'css', arg, intent });
const sendButton: SelectorRecord = { level: 'role', arg: { role: 'button', name: 'Send', exact: true }, intent: 'send button' };
const thanks: SelectorRecord = { level: 'role', arg: { role: 'alert' }, intent: 'thanks message' };
const emailAlert = css('#email_alert', 'email error');
const messageAlert = css('#message_alert', 'message error');
const form = (email: string, subject: string, message: string, by: 'value' | 'label' = 'value', first = 'Jane'): TraceStep[] => [
  { kind: 'navigate', url: `${base}/contact` },
  { kind: 'fill', target: label('First name', 'first name input'), value: first },
  { kind: 'fill', target: label('Email', 'email input'), value: email },
  { kind: 'select_option', target: label('Subject', 'subject dropdown'), by, option: subject },
  { kind: 'fill', target: label('Message', 'message textarea'), value: message },
  { kind: 'click', target: sendButton },
];
const assertStep = (assertion: TraceStep extends infer T ? T extends { kind: 'assert'; assertion: infer A } ? A : never : never): TraceStep => ({ kind: 'assert', name: 'recorded', assertion });
const happy: Scenario = { name: 'sent the contact form', category: 'happy', feature: 'contact', steps: [
  ...form('jane@example.com', 'customer-service', 'Hello, a question about tools'),
  assertStep({ type: 'toBeVisible', target: thanks, timeout: 10000 }),
  assertStep({ type: 'toContainText', target: thanks, text: 'Thanks for your message', timeout: 10000 }),
] };
const emailNegative: Scenario = { name: 'rejected an email address without an @ sign', category: 'negative', feature: 'contact', ruleIds: ['R14'], steps: [
  ...form('not-an-email', 'warranty', 'Hello, a question about tools'),
  assertStep({ type: 'toBeVisible', target: emailAlert, timeout: 10000 }),
  assertStep({ type: 'toContainText', target: emailAlert, text: '', pattern: '[Ee]mail|valid', timeout: 10000 }),
] };
const messageNegative: Scenario = { name: 'rejected an empty message', category: 'negative', feature: 'contact', steps: [
  ...form('jane@example.com', 'payments', ''),
  assertStep({ type: 'toBeVisible', target: messageAlert, timeout: 10000 }),
  assertStep({ type: 'toHaveText', target: messageAlert, text: 'Message is required', timeout: 10000 }),
] };
const reportOf = (language: 'ts' | 'js', scenarios: Scenario[]): RunReport => ({
  url: `${base}/contact`, language, scenarios,
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 0, startedAt: '', finishedAt: '',
});

const dirs: string[] = [];
try {
  /* ─── A. the data file and the spec ─────────────────────────────────── */
  const emitted: Emitted[] = (['ts', 'js'] as const).map((language) => emitFramework(reportOf(language, [happy, emailNegative, messageNegative]), 'POM', 'dataset-errors'));
  dirs.push(...emitted.map((e) => e.dir));
  for (const e of emitted) {
    const data = JSON.parse(e.files.get(path.join('data', 'contact.json')) ?? 'null') as Array<Record<string, unknown>> | null;
    const byName = (n: string) => data?.find((c) => c['name'] === n);
    const emailCase = byName(emailNegative.name);
    const messageCase = byName(messageNegative.name);
    const happyCase = byName(happy.name);
    check(`A1. ${e.language}: data/contact.json holds the three cases`, data?.length === 3, JSON.stringify(data));
    check(`A2. ${e.language}: the email case carries its recorded checks on its own element: visible, then the pattern with its flags`,
      JSON.stringify(emailCase?.['errors']) === JSON.stringify([{ element: 'emailError', check: 'visible', timeout: 10000 }, { element: 'emailError', check: 'contains', pattern: '[Ee]mail|valid', flags: '', timeout: 10000 }]), JSON.stringify(emailCase));
    check(`A3. ${e.language}: the message case carries its own: visible, then the literal, on a DIFFERENT element`,
      JSON.stringify(messageCase?.['errors']) === JSON.stringify([{ element: 'messageError', check: 'visible', timeout: 10000 }, { element: 'messageError', check: 'text', text: 'Message is required', timeout: 10000 }]), JSON.stringify(messageCase));
    check(`A4. ${e.language}: every case carries the select value its recording chose`,
      JSON.stringify(happyCase?.['selects']) === JSON.stringify({ 'subject dropdown': 'customer-service' }) &&
      JSON.stringify(emailCase?.['selects']) === JSON.stringify({ 'subject dropdown': 'warranty' }) &&
      JSON.stringify(messageCase?.['selects']) === JSON.stringify({ 'subject dropdown': 'payments' }), JSON.stringify(data?.map((c) => c['selects'])));
    check(`A5. ${e.language}: no case carries an errorText key`, !(data ?? []).some((c) => 'errorText' in c));
    const spec = e.files.get(path.join('tests', 'contact', `contact.spec.${e.language}`)) ?? '';
    check(`A6. ${e.language}: the loop selects each case's own value and asserts each error case's own checks through its element map`,
      spec.includes(`await contactPage.subjectDropdown.selectOption({ value: dataSelect(c, "subject dropdown") });`) &&
      spec.includes(`await expectDataErrors(c, { "emailError": contactPage.emailError, "messageError": contactPage.messageError });`) &&
      !spec.includes('"customer-service"') && !spec.includes('errorText'),
      spec.split('\n').filter((l) => /dataSelect\(c|expectDataErrors\(c|customer-service|errorText/.test(l)).join(' | '));
    check(`A7. ${e.language}: no emitted file asserts an empty text or the old errorText fallback`, emptyTextHits(e.files).length === 0, emptyTextHits(e.files).join(' | '));
    check(`A8. ${e.language}: a case carried whole leaves no dataset note`, e.datasetNotes.length === 0, e.datasetNotes.join(' | '));
  }

  /* ─── B. BEHAVIOR: green, then the pattern case red ─────────────────── */
  const green = await Promise.all(emitted.map(async (e) => ({ e, res: await runPlaywright(e.dir, '\\[data\\]') })));
  for (const { e, res } of green) {
    const statuses = res.specs.map((s) => `${s.title}: ${s.status}`).join(' | ');
    console.log(`   ${e.language} with the matching email error: playwright exit ${String(res.status)}; ${statuses}`);
    check(`B1. ${e.language}: the emitted framework runs green: all three data cases pass`,
      res.status === 0 && res.specs.length === 3 && res.specs.every((s) => s.status === 'expected'), statuses + ' | ' + res.out);
  }
  emailError = EMAIL_ERROR_CHANGED;
  const red = await Promise.all(emitted.map(async (e) => ({ e, res: await runPlaywright(e.dir, '\\[data\\]') })));
  for (const { e, res } of red) {
    const emailRun = res.specs.find((s) => s.title.includes(emailNegative.name));
    const others = res.specs.filter((s) => s !== emailRun);
    console.log(`   ${e.language} with "${EMAIL_ERROR_CHANGED}": playwright exit ${String(res.status)}; email case ${emailRun?.status ?? 'missing'}; others ${others.map((s) => s.status).join(', ')}`);
    check(`B2. ${e.language}: with the email error text no longer matching /[Ee]mail|valid/, the pattern data case FAILS on toContainText`,
      res.status !== 0 && emailRun?.status === 'unexpected' && /toContainText/.test(emailRun.error) && emailRun.error.includes(EMAIL_ERROR_CHANGED), JSON.stringify(emailRun));
    check(`B3. ${e.language}: the other two data cases still pass`, others.length === 2 && others.every((s) => s.status === 'expected'), others.map((s) => `${s.title}: ${s.status} ${s.error}`).join(' | '));
  }
  emailError = EMAIL_ERROR_MATCHING;

  /* ─── E. an empty pattern is as empty as an empty text ─────────────── */
  // new RegExp('') matches any text and new RegExp(' ') any text with a
  // space, so an empty or whitespace pattern proves nothing. The data file
  // writer, the recorded-check reader and the emitted guard all refuse it.
  const patternCase = (pattern: string) => [{ name: 'empty pattern', values: { a: 'b' }, expect: 'error' as const, errors: [{ target: emailAlert, check: 'contains' as const, pattern, flags: '' }] }];
  const throwsFor = (pattern: string): string => { try { renderDatasetJson({ feature: 'contact', cases: patternCase(pattern) }); return ''; } catch (e) { return `${(e as Error).name}: ${(e as Error).message}`; } };
  check('E1. writing a data case whose pattern is empty or whitespace throws, the same as an empty text',
    throwsFor('') === 'EmptyDatasetExpectationError: refusing to write data case "empty pattern": a text check with an empty pattern' &&
    throwsFor('   ') === 'EmptyDatasetExpectationError: refusing to write data case "empty pattern": a text check with an empty pattern' && throwsFor('[Ee]mail') === '',
    `${throwsFor('')} | ${throwsFor('   ')} | ${throwsFor('[Ee]mail')}`);
  const wsRecorded = recordedErrorChecks({ name: 'ws', category: 'negative', steps: [
    ...form('not-an-email', 'warranty', 'Hello, a question about tools'),
    assertStep({ type: 'toContainText', target: emailAlert, text: '', pattern: '  ', timeout: 10000 }),
  ] });
  check('E2. a recording whose pattern is whitespace cannot be carried, with the reason', 'reason' in wsRecorded && wsRecorded.reason === 'step 7 asserts an empty pattern, which proves nothing', JSON.stringify(wsRecorded));
  // The emitted guard, at run time: the data file hand-edited to an empty
  // pattern on the email case and a single-space pattern on the message case.
  // Without the guard both would pass (anything matches '', and "Message is
  // required" contains a space).
  for (const e of emitted) {
    const dataPath = path.join(e.dir, 'data', 'contact.json');
    const cases = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as Array<{ name: string; errors?: Array<Record<string, unknown>> }>;
    const emailRow = cases.find((c) => c.name === emailNegative.name)!;
    const messageRow = cases.find((c) => c.name === messageNegative.name)!;
    emailRow.errors![1] = { element: 'emailError', check: 'contains', pattern: '', flags: '', timeout: 10000 };
    messageRow.errors![1] = { element: 'messageError', check: 'text', pattern: ' ', flags: '', timeout: 10000 };
    fs.writeFileSync(dataPath, JSON.stringify(cases, null, 2) + '\n');
  }
  const guarded = await Promise.all(emitted.map(async (e) => ({ e, res: await runPlaywright(e.dir, '\\[data\\]') })));
  for (const { e, res } of guarded) {
    const emailRun = res.specs.find((sp) => sp.title.includes(emailNegative.name));
    const messageRun = res.specs.find((sp) => sp.title.includes(messageNegative.name));
    const happyRun = res.specs.find((sp) => sp.title.includes(happy.name));
    console.log(`   ${e.language} with an empty and a whitespace pattern in the data file: playwright exit ${String(res.status)}; email ${emailRun?.status ?? 'missing'}; message ${messageRun?.status ?? 'missing'}; happy ${happyRun?.status ?? 'missing'}`);
    const guardMsg = (name: string) => `data case "${name}": an empty expected text or pattern proves nothing`;
    check(`E3. ${e.language}: the emitted guard throws on an empty pattern and on a whitespace pattern, so both cases FAIL; the happy case still passes`,
      res.status !== 0 && emailRun?.status === 'unexpected' && emailRun.error.includes(guardMsg(emailNegative.name)) &&
      messageRun?.status === 'unexpected' && messageRun.error.includes(guardMsg(messageNegative.name)) && happyRun?.status === 'expected',
      JSON.stringify({ emailRun, messageRun, happyRun }));
  }

  /* ─── C. cases that cannot be carried are left out and named ────────── */
  const ariaNegative: Scenario = { name: 'rejected a blank first name', category: 'negative', feature: 'contact', steps: [
    ...form('jane@example.com', 'warranty', 'Hello, a question about tools', 'value', ''),
    assertStep({ type: 'toHaveAttribute', target: label('First name', 'first name input'), attribute: 'aria-invalid', value: 'true', timeout: 10000 }),
  ] };
  const labelSelect: Scenario = { name: 'rejected a short message chosen by subject label', category: 'negative', feature: 'contact', steps: [
    ...form('jane@example.com', 'Warranty', 'Hi', 'label'),
    assertStep({ type: 'toBeVisible', target: messageAlert, timeout: 10000 }),
  ] };
  const map: RequirementsMap = { features: [{ name: 'contact', description: 'contact form', rules: [{ id: 'R1', text: 'The message must be at least 5 characters.', type: 'validation' }] }], roles: [], truncated: false };
  const cDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-dataset-left-out-'));
  dirs.push(cDir);
  const cRes = scaffold({ report: reportOf('ts', [happy, emailNegative, messageNegative, ariaNegative, labelSelect]), outDir: cDir, siteName: 'dataset-left-out', requirements: map });
  const notes = cRes.pomResult.datasetNotes;
  const cData = JSON.parse(fs.readFileSync(path.join(cDir, 'data', 'contact.json'), 'utf8')) as Array<{ name: string }>;
  const cSpec = fs.readFileSync(path.join(cDir, 'tests', 'contact', 'contact.spec.ts'), 'utf8');
  check('C1. a case whose error assertion cannot be carried (toHaveAttribute) is left out with one note naming it and why, and ships as its own test',
    notes.filter((n) => n.includes(ariaNegative.name)).length === 1 &&
    notes.includes(`Data case "${ariaNegative.name}" (contact) left out of data/contact.json: step 7 asserts toHaveAttribute, which a data case cannot carry; it ships as its own test.`) &&
    !cData.some((c) => c.name === ariaNegative.name) && cSpec.includes(`test("[negative] ${ariaNegative.name}"`), notes.join(' | '));
  check('C2. a case whose select value cannot be carried (chosen by label where the loop selects by value) is left out and ships as its own test',
    notes.includes(`Data case "${labelSelect.name}" (contact) left out of data/contact.json: it chose "subject dropdown" by label, the loop selects it by value; it ships as its own test.`) &&
    !cData.some((c) => c.name === labelSelect.name) && cSpec.includes(`test("[negative] ${labelSelect.name}"`), notes.join(' | '));
  check('C3. a rule-derived error case has no recording: it is left out and not emitted, with its own note',
    notes.some((n) => n.startsWith('Data case "invalid: message textarea one character under the 5-character minimum" (contact) left out of data/contact.json: a rule-derived case has no recording, so it carries no error assertion; it is not emitted.')) &&
    !cData.some((c) => c.name.startsWith('invalid:')) && cData.some((c) => c.name.startsWith('boundary: message textarea at the 5-character minimum')), notes.join(' | '));
  check('C4. the carried cases stay in the loop', cData.some((c) => c.name === emailNegative.name) && cData.some((c) => c.name === messageNegative.name), JSON.stringify(cData.map((c) => c.name)));
  check('C5. no emitted file of that framework asserts an empty text', emptyTextHits(new Map([['spec', cSpec], ['data', JSON.stringify(cData)]])).length === 0);

  /* ─── D. the rule 2 guard in both emitters, both languages ──────────── */
  const emptyScenario: Scenario = { name: 'asserts an empty text', category: 'happy', feature: 'contact', steps: [
    { kind: 'navigate', url: `${base}/contact` },
    { kind: 'click', target: sendButton },
    assertStep({ type: 'toContainText', target: emailAlert, text: '' }),
  ] };
  for (const language of ['ts', 'js'] as const) {
    for (const shape of ['POM', 'single file'] as const) {
      const dDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-empty-text-'));
      dirs.push(dDir);
      let thrown: unknown = null;
      try {
        if (shape === 'POM') scaffold({ report: reportOf(language, [emptyScenario]), outDir: dDir, siteName: 'empty-text' });
        else transcribe({ report: reportOf(language, [emptyScenario]), outDir: dDir, name: 'empty-text' });
      } catch (err) { thrown = err; }
      check(`D1. ${language} ${shape}: emitting toContainText('') throws EmptyTextExpectationError`,
        thrown instanceof EmptyTextExpectationError && (thrown as Error).name === 'EmptyTextExpectationError' && (thrown as Error).message.includes('toContainText on email error'), String(thrown));
    }
  }

  // The tool refuses an empty expected text before it is ever recorded.
  const browser = await chromium.launch({ headless: true });
  try {
    const bctx = await browser.newContext();
    await installEvalShim(bctx);
    const page = await bctx.newPage();
    const ctx = createContext(page, 30);
    const begun = await runTool(ctx, { name: 'begin_scenario', input: { name: 'empty text', category: 'negative', feature: 'contact' } });
    const nav = await runTool(ctx, { name: 'navigate', input: { url: `${base}/contact` } });
    const contains = await runTool(ctx, { name: 'assert', input: { type: 'toContainText', intent: 'email error', css: '#email_alert', text: '' } });
    const exact = await runTool(ctx, { name: 'assert', input: { type: 'toHaveText', intent: 'email error', css: '#email_alert', text: '   ' } });
    const waited = await runTool(ctx, { name: 'wait_for_text', input: { intent: 'email error', css: '#email_alert', text: '' } });
    check('D2. the tool refuses toContainText(\'\'), toHaveText with whitespace only and wait_for_text(\'\'), and records nothing',
      begun.ok && nav.ok && contains.ok === false && /empty expected text proves nothing/.test(contains.error ?? '') && exact.ok === false && /empty expected text proves nothing/.test(exact.error ?? '') &&
      waited.ok === false && /non-empty text/.test(waited.error ?? '') && (ctx.current?.steps ?? []).every((st) => st.kind !== 'assert'),
      JSON.stringify({ contains, exact, waited }));
  } finally {
    await browser.close();
  }
} finally {
  server.close();
  cleanup(dirs);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: dataset error cases carry their own recorded checks (a pattern with its flags or a literal, plus visibility) on their own error elements and their own select values; the emitted framework runs green and its pattern case goes red when the error text stops matching (TS and JS); cases that cannot be carried are left out with a note; no emitter writes an empty text expectation.');
