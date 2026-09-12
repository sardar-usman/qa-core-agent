/**
 * Locks surface parity: the CLI, the dashboard gateway and the MCP server
 * build the SAME ExploreRequest and the SAME runtime options for the same
 * ask. No live run: the three parsers are pure, and buildExploreOptions is
 * the single mapping to ExploreOptions.
 *
 * Also walks EXPLORE_FLAGS (the flag registry in explore-request.ts):
 *   - every registered flag parses (no "Unknown flag"),
 *   - every flag with an MCP name has that argument in the qa_explore or
 *     qa_resume schema, and the argument's description names the CLI flag,
 *   - every flag marked gateway-reachable is accepted by /explore text,
 *   - every flag WITHOUT parity carries a stated reason,
 *   - the tool names stay stable (qa_explore, qa_generate, qa_heal) and the
 *     two new tools exist (qa_resume, qa_transcribe).
 */
import { z } from 'zod';
import {
  parseExploreArgv, parseExploreTokens, buildExploreOptions, EXPLORE_FLAGS, RUN_ENV_SETTINGS,
  type ExploreRequest,
} from '../src/agent/explore-request.js';
import { parseGatewayCommand } from '../src/server/commands.js';
import { exploreRequestFromToolArgs, resumeRequestFromToolArgs, TOOL_SCHEMAS, TOOL_NAMES, exploreArgs, resumeArgs } from '../src/mcp/tools.js';
import type { Checkpoint } from '../src/agent/checkpoint.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

/* ─── 1. Same ask, three surfaces, one request ─── */

const cliArgv = ['https://shop.example/', '--features', 'login,cart', '--srs', 'docs/srs.md', '--urls', '/login,/cart', '--discover', '--lang', 'js', '--no-pom', '--no-stabilize', '--stabilize-attempts', '2', '--stability', '5', '--no-replay', '--ceiling', '3', '--repair-reserve', '0.2', '--max-steps', '60', '--planner-model', 'claude-haiku-4-5', '--explorer-model', 'claude-opus-4-7', '--critic-model', 'claude-sonnet-4-6', '--name', 'shop'];
const cli = parseExploreArgv(cliArgv);
const gw = parseGatewayCommand('/explore ' + cliArgv.join(' '), { lang: 'ts' });
const mcpArgs = z.object(exploreArgs).parse({
  url: 'https://shop.example/', features: ['login', 'cart'], srs: 'docs/srs.md', urls: ['/login', '/cart'], discover: true, language: 'js', pom: false,
  stabilize: false, stabilizeAttempts: 2, stabilityIterations: 5, replay: false, ceilingUsd: 3, repairReserve: 0.2, maxSteps: 60,
  plannerModel: 'claude-haiku-4-5', explorerModel: 'claude-opus-4-7', criticModel: 'claude-sonnet-4-6', name: 'shop',
});
const mcp = exploreRequestFromToolArgs(mcpArgs);

check('A. CLI argv parses', cli.ok);
check('B. gateway text parses', gw.kind === 'explore');
const cliReq = cli.ok ? cli.request : null;
const gwReq = gw.kind === 'explore' ? gw.request : null;
check('C. CLI and gateway build the same ExploreRequest', !!cliReq && !!gwReq && same(cliReq, gwReq), JSON.stringify({ cliReq, gwReq }));
check('D. MCP builds the same ExploreRequest', !!cliReq && same(cliReq, mcp), JSON.stringify({ cliReq, mcp }));

const ctx = { url: 'https://shop.example/', outDir: '/tmp/out/shop-automation-framework' };
const optsCli = cliReq && buildExploreOptions(cliReq, ctx);
const optsGw = gwReq && buildExploreOptions(gwReq, ctx);
const optsMcp = buildExploreOptions(mcp, ctx);
check('E. the three surfaces produce identical runtime options', !!optsCli && same(optsCli, optsGw) && same(optsCli, optsMcp), JSON.stringify({ optsCli, optsGw, optsMcp }));
check('F. options carry every flag: language, skips, stability, stabilizer, features, discover, urls, checkpointFlags',
  !!optsCli && optsCli.language === 'js' && optsCli.skipReplay === true && optsCli.skipStability === false && optsCli.stabilityIterations === 5 && optsCli.stabilize === false && optsCli.maxStabilizeAttempts === 2 && JSON.stringify(optsCli.features) === '["login","cart"]' && optsCli.discover === true && JSON.stringify(optsCli.urls) === '["/login","/cart"]' && optsCli.checkpointFlags?.pom === false && optsCli.checkpointFlags?.srsPath === 'docs/srs.md', JSON.stringify(optsCli));
check('G. setting overrides are the same env map on every surface', !!cliReq && same(cliReq.env, mcp.env) && same(cliReq.env, gwReq?.env) && Object.keys(cliReq.env).length === 6, JSON.stringify(cliReq?.env));

/* ─── 2. Defaults agree too ─── */

const cliMin = parseExploreArgv(['https://shop.example/']);
const gwMin = parseGatewayCommand('/explore https://shop.example/', { lang: 'ts' });
const mcpMin = exploreRequestFromToolArgs(z.object(exploreArgs).parse({ url: 'https://shop.example/' }));
const norm = (r: ExploreRequest | null): unknown => r && { ...r, langProvided: undefined, pomProvided: undefined };
check('H. minimal ask: CLI, gateway and MCP agree (ignoring the provided-flags markers)',
  cliMin.ok && gwMin.kind === 'explore' && same(norm(cliMin.request), norm(gwMin.request)) && same(norm(cliMin.request), norm(mcpMin)),
  JSON.stringify({ cli: cliMin.ok && cliMin.request, gw: gwMin.kind === 'explore' && gwMin.request, mcpMin }));
check('I. minimal ask builds the same options on all three', cliMin.ok && gwMin.kind === 'explore' && same(buildExploreOptions(cliMin.request, ctx), buildExploreOptions(gwMin.request, ctx)) && same(buildExploreOptions(cliMin.request, ctx), buildExploreOptions(mcpMin, ctx)));

/* ─── 3. Resume: same request, same options, checkpoint flags win ─── */

const cp: Checkpoint = {
  version: 1, url: 'https://shop.example/', flags: { lang: 'js', pom: false, features: ['login'], discover: true, urls: ['/login'], srs: 'docs/srs.md' },
  plan: [{ name: 'a', category: 'happy', rationale: 'r' }], fillableFields: 2, completedScenarios: [], spentUsd: { planner: 0.01, explorer: 0.5, critic: 0, repair: 0 },
  phase: 'exploring', nextScenarioIndex: 0, startedAt: 's', updatedAt: 'u',
};
const cliRes = parseExploreArgv(['--resume', 'output/shop/checkpoint.json', '--ceiling', '4']);
const gwRes = parseGatewayCommand('/resume output/shop/checkpoint.json --ceiling 4', { lang: 'ts' });
const mcpRes = resumeRequestFromToolArgs(z.object(resumeArgs).parse({ checkpointPath: 'output/shop/checkpoint.json', ceilingUsd: 4 }));
check('J. resume: CLI, gateway and MCP build the same request', cliRes.ok && gwRes.kind === 'explore' && same(cliRes.request, gwRes.request) && same(cliRes.request, mcpRes), JSON.stringify({ cli: cliRes.ok && cliRes.request, gw: gwRes.kind === 'explore' && gwRes.request, mcpRes }));
const resCtx = { url: cp.url, outDir: '/tmp/out/shop', resume: cp };
const resOpts = cliRes.ok ? buildExploreOptions(cliRes.request, resCtx) : null;
check('K. resume options restore discover/urls/srs from the checkpoint and carry it as `resume`', !!resOpts && resOpts.discover === true && JSON.stringify(resOpts.urls) === '["/login"]' && resOpts.checkpointFlags?.srsPath === 'docs/srs.md' && resOpts.resume === cp, JSON.stringify(resOpts));
check('L. resume options identical across surfaces', !!resOpts && gwRes.kind === 'explore' && same(resOpts, buildExploreOptions(gwRes.request, resCtx)) && same(resOpts, buildExploreOptions(mcpRes, resCtx)));

/* ─── 4. The flag registry: every CLI flag has a stated reach ─── */

const exploreSchema = z.object(exploreArgs);
const resumeSchema = z.object(resumeArgs);
for (const f of EXPLORE_FLAGS) {
  const sample = f.flag === '--lang' ? 'js' : f.flag === '--env' ? 'QA_CORE_COST_CEILING=3' : /model/.test(f.flag) ? 'claude-haiku-4-5' : /reserve/.test(f.flag) ? '0.2' : /ceiling|steps|stability|attempts/.test(f.flag) ? '2' : 'x';
  const tokens = f.takesValue ? [f.flag, sample] : [f.flag];
  const parsed = parseExploreTokens(tokens);
  check(`M. ${f.flag} parses`, parsed.ok, parsed.ok ? '' : parsed.error);
  if (f.mcp) {
    const inExplore = f.mcp in exploreSchema.shape;
    const inResume = f.mcp in resumeSchema.shape;
    check(`N. ${f.flag} has MCP argument ${f.mcp}`, inExplore || inResume);
    const desc = (inExplore ? exploreSchema.shape[f.mcp as keyof typeof exploreArgs] : resumeSchema.shape[f.mcp as keyof typeof resumeArgs]).description ?? '';
    check(`O. ${f.mcp} description names the CLI flag`, desc.includes(f.flag) || (f.flag === '--pom' && desc.includes('--no-pom')) || (f.flag === '--replay' && desc.includes('--no-replay')) || (f.flag === '--stabilize' && desc.includes('--no-stabilize')) || (f.flag === '--no-stability' && desc.includes('--no-stability')), desc);
  } else {
    check(`P. ${f.flag} without MCP parity states why`, !!f.note && f.note.length > 20);
  }
  if (f.gateway) {
    const gwText = f.flag === '--resume' ? `/explore ${tokens.join(' ')}` : `/explore https://shop.example/ ${tokens.join(' ')}`;
    const g = parseGatewayCommand(gwText, { lang: 'ts' });
    check(`Q. ${f.flag} accepted by /explore`, g.kind === 'explore', g.kind === 'reply' ? g.text : '');
  } else {
    const g = parseGatewayCommand(`/explore https://shop.example/ ${tokens.join(' ')}`, { lang: 'ts' });
    check(`R. ${f.flag} refused by /explore with a reason`, g.kind === 'reply' && !!f.note, g.kind);
  }
}
// The registry must cover the parser: probe a flag that is not registered.
check('S. an unregistered flag is rejected by the parser', !parseExploreTokens(['--not-a-flag']).ok);
// Every env setting has a CLI flag in the registry and an MCP argument.
for (const s of RUN_ENV_SETTINGS) {
  const row = EXPLORE_FLAGS.find((f) => f.flag === s.flag);
  check(`T. ${s.name} reachable via ${s.flag} and MCP ${row?.mcp ?? '?'}`, !!row && !!row.mcp && row.mcp in exploreSchema.shape && row.mcp in resumeSchema.shape);
}

/* ─── 5. Tool names and schemas ─── */

check('U. tool names stable and complete', JSON.stringify([...TOOL_NAMES]) === '["qa_explore","qa_resume","qa_transcribe","qa_generate","qa_heal"]');
for (const name of TOOL_NAMES) {
  const shape = TOOL_SCHEMAS[name];
  const undocumented = Object.entries(shape).filter(([, schema]) => !(schema as z.ZodTypeAny).description).map(([k]) => k);
  check(`V. every ${name} argument is documented`, undocumented.length === 0, undocumented.join(', '));
}
check('W. qa_transcribe takes reportPath and outDir', 'reportPath' in TOOL_SCHEMAS.qa_transcribe && 'outDir' in TOOL_SCHEMAS.qa_transcribe);
check('X. qa_explore accepts srsText as the inline SRS form', 'srsText' in TOOL_SCHEMAS.qa_explore);
const inline = exploreRequestFromToolArgs(exploreSchema.parse({ url: 'https://shop.example/', srsText: '# SRS' }), 'output/.uploads/x.md');
check('Y. inline SRS text becomes an srs path on the request (same as --srs)', inline.srs === 'output/.uploads/x.md');
check('Z. an invalid setting value throws at the MCP boundary', (() => { try { exploreRequestFromToolArgs(exploreSchema.parse({ url: 'https://shop.example/', plannerModel: 'not a model id' })); return false; } catch (e) { return /model id/.test((e as Error).message); } })());

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: CLI, dashboard and MCP build identical explore requests and runtime options; every CLI flag has a stated reach on both surfaces.');
