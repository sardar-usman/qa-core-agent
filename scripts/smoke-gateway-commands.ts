/**
 * Locks the dashboard command parser (src/server/commands.ts): every explore
 * option the CLI accepts is reachable from `/explore` text, plus `/resume`
 * and `/transcribe`, with paste-hint behavior for the new flags. Pure: no
 * gateway process, no model, no network.
 */
import { parseGatewayCommand, EXPLORE_USAGE, RESUME_USAGE, TRANSCRIBE_USAGE } from '../src/server/commands.js';
import { tokenizeCommand } from '../src/agent/explore-request.js';
import { loadReportForUi } from '../src/server/runs.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};
const D = { lang: 'ts' as const };

/* ─── /explore: every flag ─── */

const full = parseGatewayCommand(
  '/explore https://shop.example/ --features login,cart --srs docs/srs.md --urls /login,/cart --discover --lang js --no-pom --no-stabilize --stabilize-attempts 2 --stability 5 --no-replay --ceiling 3 --repair-reserve 0.2 --max-steps 60 --planner-model claude-haiku-4-5 --name shop',
  D,
);
check('A. full /explore parses as an explore command', full.kind === 'explore');
if (full.kind === 'explore') {
  const r = full.request;
  check('B. url is the first bare token', r.url === 'https://shop.example/');
  check('C. --features parsed', JSON.stringify(r.features) === '["login","cart"]', JSON.stringify(r.features));
  check('D. --srs parsed', r.srs === 'docs/srs.md');
  check('E. --urls parsed', JSON.stringify(r.urls) === '["/login","/cart"]');
  check('F. --discover parsed', r.discover === true);
  check('G. --lang js wins over the dashboard default', r.lang === 'js' && r.langProvided);
  check('H. --no-pom parsed', r.pom === false && r.pomProvided);
  check('I. --no-stabilize + --stabilize-attempts parsed', r.stabilize === false && r.stabilizeAttempts === 2);
  check('J. --stability N + --no-replay parsed', r.stabilityIterations === 5 && r.replay === false);
  check('K. setting flags map to the env names the runtime reads',
    r.env.QA_CORE_COST_CEILING === '3' && r.env.QA_CORE_REPAIR_RESERVE === '0.2' && r.env.QA_CORE_MAX_STEPS === '60' && r.env.QA_CORE_PLANNER_MODEL === 'claude-haiku-4-5', JSON.stringify(r.env));
  check('L. --name parsed', r.name === 'shop');
  check('M. no natural hint when --features is given', full.naturalHint === undefined);
  check('N. notes mention the stabilizer being off and each setting override', full.notes.some((n) => /Stabilizer.*OFF/.test(n)) && full.notes.some((n) => /Cost ceiling.*= 3/.test(n)), JSON.stringify(full.notes));
}

/* ─── defaults and natural language ─── */

const plain = parseGatewayCommand('/explore shop.example test login and cart', { lang: 'js' });
check('O. dashboard lang default applies when --lang is absent', plain.kind === 'explore' && plain.request.lang === 'js' && !plain.request.langProvided);
check('P. words after the URL become the natural-language hint', plain.kind === 'explore' && plain.naturalHint === 'test login and cart');
check('Q. defaults: pom, replay, stability 3, stabilize, 3 attempts, no discovery', plain.kind === 'explore' && plain.request.pom && plain.request.replay && plain.request.stability && plain.request.stabilityIterations === 3 && plain.request.stabilize && plain.request.stabilizeAttempts === 3 && !plain.request.discover && plain.request.urls.length === 0);

const withEnv = parseGatewayCommand('/explore https://shop.example/ --ceiling 5', { lang: 'ts', env: { QA_CORE_COST_CEILING: '9', QA_CORE_CRITIC_MODEL: 'claude-sonnet-4-6' } });
check('R. dashboard env overrides merge under the text flags (text wins)', withEnv.kind === 'explore' && withEnv.request.env.QA_CORE_COST_CEILING === '5' && withEnv.request.env.QA_CORE_CRITIC_MODEL === 'claude-sonnet-4-6', withEnv.kind === 'explore' ? JSON.stringify(withEnv.request.env) : withEnv.kind);
const badEnv = parseGatewayCommand('/explore https://shop.example/', { lang: 'ts', env: { ANTHROPIC_API_KEY: 'x' } });
check('S. an env name outside the per-run allowlist is rejected', badEnv.kind === 'reply' && /not a per-run setting/.test(badEnv.text));
const badCeiling = parseGatewayCommand('/explore https://shop.example/ --ceiling abc', D);
check('T. a non-numeric ceiling is rejected with the usage', badCeiling.kind === 'reply' && /QA_CORE_COST_CEILING must be a positive number/.test(badCeiling.text));

/* ─── quoting and npm-style leftovers ─── */

const quoted = parseGatewayCommand('/explore https://shop.example/ --srs "docs/My SRS v2.pdf"', D);
check('U. a quoted path with spaces stays one token', quoted.kind === 'explore' && quoted.request.srs === 'docs/My SRS v2.pdf');
check('V. tokenizer handles single quotes and empty quotes', JSON.stringify(tokenizeCommand(`a 'b c' "" d`)) === '["a","b c","","d"]', JSON.stringify(tokenizeCommand(`a 'b c' "" d`)));
const dashed = parseGatewayCommand('/explore -- https://shop.example/ --discover', D);
check('W. leading npm-style `--` is stripped and noted', dashed.kind === 'explore' && dashed.request.url === 'https://shop.example/' && dashed.request.discover && dashed.notes.some((n) => /removed the leading/.test(n)));

/* ─── errors and usage ─── */

check('X. bare /explore returns the usage', parseGatewayCommand('/explore', D).kind === 'reply' && (parseGatewayCommand('/explore', D) as { text: string }).text === EXPLORE_USAGE);
const unknown = parseGatewayCommand('/explore https://shop.example/ --disocver', D);
check('Y. an unknown flag is an error, never part of the hint', unknown.kind === 'reply' && /Unknown flag --disocver/.test(unknown.text));
const out = parseGatewayCommand('/explore https://shop.example/ --out /tmp/x', D);
check('Z. --out is refused on the dashboard with a reason', out.kind === 'reply' && /--out is not available/.test(out.text));
const review = parseGatewayCommand('/explore https://shop.example/ --review', D);
check('AA. --review is refused on the dashboard with a reason', review.kind === 'reply' && /needs the CLI/.test(review.text));
const missing = parseGatewayCommand('/explore https://shop.example/ --features', D);
check('AB. a value flag without a value is an error', missing.kind === 'reply' && /--features expects/.test(missing.text));

/* ─── /resume ─── */

const resume = parseGatewayCommand('/resume output/shop-automation-framework/checkpoint.json --ceiling 4', D);
check('AC. /resume parses to an explore request carrying resume + ceiling', resume.kind === 'explore' && resume.request.resume === 'output/shop-automation-framework/checkpoint.json' && resume.request.env.QA_CORE_COST_CEILING === '4');
const resumeViaExplore = parseGatewayCommand('/explore --resume output/shop-automation-framework/checkpoint.json --ceiling 4', D);
check('AD. /explore --resume is the same request as /resume', JSON.stringify(resumeViaExplore.kind === 'explore' && resumeViaExplore.request) === JSON.stringify(resume.kind === 'explore' && resume.request));
check('AE. bare /resume returns the usage', (parseGatewayCommand('/resume', D) as { text: string }).text === RESUME_USAGE);
const resumeNoUrl = parseGatewayCommand('/resume output/x/checkpoint.json', D);
check('AF. /resume needs no URL (the checkpoint carries it)', resumeNoUrl.kind === 'explore' && resumeNoUrl.request.url === undefined);

/* ─── /transcribe ─── */

const tr = parseGatewayCommand('/transcribe output/shop-automation-framework/run-report.json --out output/regen', D);
check('AG. /transcribe parses report path and --out', tr.kind === 'transcribe' && tr.reportPath === 'output/shop-automation-framework/run-report.json' && tr.outDir === 'output/regen');
const tr2 = parseGatewayCommand('/transcribe output/shop-automation-framework/run-report.json', D);
check('AH. /transcribe without --out has no outDir key', tr2.kind === 'transcribe' && !('outDir' in tr2));
check('AI. bare /transcribe returns the usage', (parseGatewayCommand('/transcribe', D) as { text: string }).text === TRANSCRIBE_USAGE);
const trBad = parseGatewayCommand('/transcribe report.json --zip', D);
check('AJ. /transcribe rejects unknown flags', trBad.kind === 'reply' && /Unknown flag --zip/.test(trBad.text));

/* ─── paste hints carry the new flags ─── */

const pasteSrs = parseGatewayCommand('npm run explore -- https://shop.example/ --srs docs/srs.md --urls /a,/b --discover', D);
check('AK. pasted npm explore with --srs/--urls/--discover suggests the slash form with the flags intact',
  pasteSrs.kind === 'reply' && /`\/explore https:\/\/shop\.example\/ --srs docs\/srs\.md --urls \/a,\/b --discover`/.test(pasteSrs.text), pasteSrs.kind === 'reply' ? pasteSrs.text : '');
const pasteResume = parseGatewayCommand('npm run explore -- --resume output/x/checkpoint.json', D);
check('AL. pasted npm explore --resume suggests /explore --resume', pasteResume.kind === 'reply' && /`\/explore --resume output\/x\/checkpoint\.json`/.test(pasteResume.text));
const pasteTr = parseGatewayCommand('npm run transcribe -- output/x/run-report.json --out out', D);
check('AM. pasted npm transcribe suggests /transcribe with its args', pasteTr.kind === 'reply' && /`\/transcribe output\/x\/run-report\.json --out out`/.test(pasteTr.text));
const suggested = parseGatewayCommand('/explore https://shop.example/ --srs docs/srs.md --urls /a,/b --discover', D);
check('AN. the suggested command parses to the same request the CLI flags describe', suggested.kind === 'explore' && suggested.request.srs === 'docs/srs.md' && suggested.request.urls.length === 2 && suggested.request.discover);

/* ─── other commands unchanged ─── */

check('AO. /generate', (() => { const c = parseGatewayCommand('/generate As a user I log in', D); return c.kind === 'generate' && c.story === 'As a user I log in'; })());
check('AP. /heal', (() => { const c = parseGatewayCommand('/heal tests/login.spec.ts', D); return c.kind === 'heal' && c.specPath === 'tests/login.spec.ts'; })());
check('AQ. /eval --no-pom', (() => { const c = parseGatewayCommand('/eval --no-pom', D); return c.kind === 'eval' && c.pom === false; })());
check('AR. unknown command lists /resume and /transcribe in the help', (() => { const c = parseGatewayCommand('hello', D); return c.kind === 'reply' && /\/resume/.test(c.text) && /\/transcribe/.test(c.text); })());

/* ─── get_report: the history view loads a report, never an arbitrary file ─── */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-getreport-'));
fs.mkdirSync(path.join(root, 'output', 'x-automation-framework'), { recursive: true });
fs.writeFileSync(path.join(root, 'output', 'x-automation-framework', 'run-report.json'), JSON.stringify({ url: 'https://x.example/', language: 'ts', scenarios: [{ name: 'a', steps: [{ kind: 'navigate', url: 'https://x.example/' }] }], cost: { usd: 0 } }));
fs.writeFileSync(path.join(root, 'output', 'x-automation-framework', 'checkpoint.json'), '{}');
fs.writeFileSync(path.join(root, 'secret.txt'), 'nope');
const loaded = loadReportForUi(root, 'output/x-automation-framework/run-report.json');
check('AS. get_report loads a report under the root with traces stripped and checkpoint noted',
  (loaded.report.scenarios as Array<Record<string, unknown>>)[0]?.stepCount === 1 && !('steps' in (loaded.report.scenarios as Array<Record<string, unknown>>)[0]!) && loaded.outcome.checkpointPath === 'output/x-automation-framework/checkpoint.json' && loaded.outcome.kind === 'framework');
check('AT. get_report refuses a path outside the root', (() => { try { loadReportForUi(root, '../etc/passwd'); return false; } catch (e) { return /Refusing/.test((e as Error).message); } })());
check('AU. get_report refuses a file that is not run-report.json', (() => { try { loadReportForUi(root, 'secret.txt'); return false; } catch (e) { return /Refusing/.test((e as Error).message); } })());
check('AV. get_report reports a missing report plainly', (() => { try { loadReportForUi(root, 'output/none/run-report.json'); return false; } catch (e) { return /not found/.test((e as Error).message); } })());
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the dashboard command parser accepts every explore option, /resume, /transcribe, and paste hints for the new flags.');
