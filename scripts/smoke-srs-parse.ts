/**
 * Locks SRS ingestion (src/agent/requirements.ts), without any LLM call:
 *   - loadSrsText reads a .md file directly.
 *   - The 60,000-character cap truncates and reports truncated=true.
 *   - An unsupported extension is rejected with an error naming the
 *     supported ones.
 *   - parseRequirementsResponse (the parse step behind buildRequirementsMap)
 *     recovers a fenced response, accepts a clean response, tolerates prose
 *     around the JSON, normalizes feature names to kebab-case, renumbers
 *     colliding rule ids, and throws clearly on a malformed response.
 *   - requirementsMapForSrs caches the map by SRS content hash under
 *     output/<slug>/srs/<hash>/requirements-map.json: a second run with the
 *     same bytes reuses it with no build call, --rebuild-srs-map builds
 *     again, and a changed byte is a new hash and a new build (run 51d535:
 *     the same SRS gave five features in run 4 and four in run 5).
 *
 * No network. No LLM. Temp files only.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadSrsText, parseRequirementsResponse, requirementsMapForSrs, cachedMapPath, srsContentHash, SRS_MAP_HASH_PREFIX, SRS_TEXT_CAP, type RequirementsMap } from '../src/agent/requirements.js';
import { totalCost, costLine, hasRequirementsCost, REQUIREMENTS_COST_NOT_RECORDED } from '../src/agent/cost-total.js';
import { summarize } from '../src/server/run-explore.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-srs-'));

const FIXTURE_SRS = `# Login requirements

The login page is at /login.

- The password must be at least 8 characters.
- The email field is required.
- After a successful login the user lands on the dashboard.
- Only admins may open the settings page.
`;

/* ─── A. .md loads directly, no truncation ─────────────────────────────────── */
const mdPath = path.join(tmpRoot, 'srs.md');
fs.writeFileSync(mdPath, FIXTURE_SRS);
const loaded = await loadSrsText(mdPath);
check('A1. .md loads the exact text', loaded.text === FIXTURE_SRS);
check('A2. under the cap is not truncated', loaded.truncated === false);

/* ─── B. the 60k cap truncates and reports it ──────────────────────────────── */
const bigPath = path.join(tmpRoot, 'big.txt');
fs.writeFileSync(bigPath, 'R'.repeat(SRS_TEXT_CAP + 5_000));
const big = await loadSrsText(bigPath);
check('B1. oversized text is cut at the cap', big.text.length === SRS_TEXT_CAP);
check('B2. truncation is recorded', big.truncated === true);

/* ─── C. unsupported extension fails with a clear error ────────────────────── */
const rtfPath = path.join(tmpRoot, 'srs.rtf');
fs.writeFileSync(rtfPath, 'not supported');
let rtfError = '';
try { await loadSrsText(rtfPath); } catch (err) { rtfError = (err as Error).message; }
check('C1. .rtf is rejected', rtfError.length > 0);
check('C2. the error names the supported extensions', ['.md', '.txt', '.pdf', '.docx'].every((e) => rtfError.includes(e)), rtfError);

/* ─── D. parse step: clean response ────────────────────────────────────────── */
const CLEAN = JSON.stringify({
  features: [
    {
      name: 'login',
      description: 'Users sign in with email and password.',
      urls: ['/login'],
      rules: [
        { id: 'R1', text: 'The password must be at least 8 characters.', type: 'validation' },
        { id: 'R2', text: 'The email field is required.', type: 'validation' },
      ],
    },
  ],
  roles: ['admin'],
});
const clean = parseRequirementsResponse(CLEAN);
check('D1. clean JSON parses', clean.features.length === 1 && clean.features[0]!.name === 'login');
check('D2. rules survive with id + type', clean.features[0]!.rules.length === 2 && clean.features[0]!.rules[0]!.id === 'R1' && clean.features[0]!.rules[0]!.type === 'validation');
check('D3. stated urls survive', (clean.features[0]!.urls ?? []).includes('/login'));
check('D4. roles survive', clean.roles.includes('admin'));

/* ─── E. parse step: fenced response is recovered ──────────────────────────── */
const fenced = parseRequirementsResponse('```json\n' + CLEAN + '\n```');
check('E1. a ```json fence is stripped', fenced.features.length === 1 && fenced.features[0]!.rules.length === 2);
const withProse = parseRequirementsResponse('Here is the requirements map you asked for:\n\n' + CLEAN + '\n\nLet me know if you need anything else.');
check('E2. prose around the JSON object is tolerated', withProse.features.length === 1);

/* ─── F. parse step: normalization + id repair ─────────────────────────────── */
const MESSY = JSON.stringify({
  features: [
    { name: 'User Registration', description: 'x', rules: [{ id: 'R1', text: 'a', type: 'validation' }, { id: 'R1', text: 'b', type: 'weird-type' }] },
    { name: 'cart', description: 'y', rules: [{ text: 'c', type: 'behavior' }] },
  ],
  roles: [],
});
const messy = parseRequirementsResponse(MESSY);
check('F1. feature names normalize to kebab-case', messy.features[0]!.name === 'user-registration');
const allIds = messy.features.flatMap((f) => f.rules.map((r) => r.id));
check('F2. colliding/missing ids are renumbered unique', new Set(allIds).size === allIds.length && allIds.every((id) => /^R\d+$/.test(id)), JSON.stringify(allIds));
check('F3. an unknown rule type falls back to behavior', messy.features[0]!.rules[1]!.type === 'behavior');
check('F4. a feature without stated urls has no urls key', !('urls' in messy.features[1]!));

/* ─── G. parse step: malformed responses throw clearly ─────────────────────── */
const throws = (input: string): string => {
  try { parseRequirementsResponse(input); return ''; } catch (err) { return (err as Error).message; }
};
check('G1. non-JSON throws', throws('this is not json at all').length > 0);
check('G2. a JSON array (wrong shape) throws', throws('[1,2,3]').length > 0);
check('G3. an object without features throws', throws('{"roles":[]}').includes('features'));
check('G4. an object with zero usable features throws', throws('{"features":[{"rules":[]}],"roles":[]}').length > 0);

/* ─── H. the map cache: one map per SRS content hash ──────────────────────── */
{
  const outputRoot = path.join(tmpRoot, 'output');
  const slug = 'practicesoftwaretesting-com';
  const srsFile = path.join(tmpRoot, 'toolshop-srs.md');
  fs.writeFileSync(srsFile, FIXTURE_SRS);
  let builds = 0;
  const fiveFeatures: RequirementsMap = { features: Array.from({ length: 5 }, (_, i) => ({ name: `feature-${i + 1}`, description: 'd', rules: [{ id: `R${i + 1}`, text: 'rule', type: 'behavior' as const }] })), roles: [], truncated: false };
  const build = async () => { builds++; return { map: fiveFeatures, costUsd: 0.0123 }; };
  const common = { outputRoot, slug, apiKey: 'fake', build };
  const first = await requirementsMapForSrs({ ...common, srsPath: srsFile });
  const hash = srsContentHash(fs.readFileSync(srsFile)).slice(0, SRS_MAP_HASH_PREFIX);
  check('H1. the first run builds the map, prints "built (<hash>)" and charges the build', builds === 1 && first.reused === false && first.line === `requirements map: built (${hash})` && first.costUsd === 0.0123, first.line);
  check('H2. the map is cached under output/<slug>/srs/<hash>/requirements-map.json', first.cachePath === cachedMapPath(outputRoot, slug, hash) && fs.existsSync(first.cachePath) && first.cachePath.includes(path.join('output', slug, 'srs', hash, 'requirements-map.json')), first.cachePath);
  const second = await requirementsMapForSrs({ ...common, srsPath: srsFile });
  check('H3. a second run with the same bytes reuses it: no build call, "reused (<hash>)", zero cost, the same five features', builds === 1 && second.reused === true && second.line === `requirements map: reused (${hash})` && second.costUsd === 0 && second.map.features.length === 5 && JSON.stringify(second.map) === JSON.stringify(fiveFeatures), second.line);
  const forced = await requirementsMapForSrs({ ...common, srsPath: srsFile, rebuild: true });
  check('H4. --rebuild-srs-map builds again on the same bytes', builds === 2 && forced.reused === false && forced.line === `requirements map: built (${hash})`, forced.line);
  fs.writeFileSync(srsFile, FIXTURE_SRS + ' ');
  const changed = await requirementsMapForSrs({ ...common, srsPath: srsFile });
  const hash2 = srsContentHash(fs.readFileSync(srsFile)).slice(0, SRS_MAP_HASH_PREFIX);
  check('H5. a changed byte is a new hash and a new build, and the old cache entry stays', builds === 3 && changed.reused === false && hash2 !== hash && changed.line === `requirements map: built (${hash2})` && fs.existsSync(first.cachePath) && fs.existsSync(changed.cachePath), changed.line);
  fs.writeFileSync(first.cachePath, '{ not json');
  fs.writeFileSync(srsFile, FIXTURE_SRS);
  const corrupt = await requirementsMapForSrs({ ...common, srsPath: srsFile });
  check('H6. an unreadable cache entry is rebuilt, never trusted', builds === 4 && corrupt.reused === false && JSON.parse(fs.readFileSync(first.cachePath, 'utf8')).features.length === 5);
  check('H7. the hash prefix names the directory with 12 hex characters', /^[0-9a-f]{12}$/.test(hash) && SRS_MAP_HASH_PREFIX === 12);

  /* ─── I. D5: the map cost reaches every total through the one totalCost ─── */
  // Run 44cb3d printed "Cost: $6.0912 total (planner, explorer, critic)" with
  // nothing for the $0.0048 map build: the CLI, the gateway and the index
  // each summed their own terms. cost.requirementsUsd is the build cost when
  // the map was built this run (first.costUsd), 0 when reused (second.costUsd),
  // and totalCost/costLine (src/agent/cost-total.ts) are the one place the
  // total is summed and printed.
  const base: RunReport['cost'] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 5.9386, plannerUsd: 0.0336, criticUsd: 0.1189 };
  const oldTotal = 5.9386 + 0.0336 + 0.1189;
  const builtRun = { cost: { ...base, requirementsUsd: first.costUsd } };
  check('I1. a built map adds its build cost to the total', Math.abs(totalCost(builtRun) - (oldTotal + 0.0123)) < 1e-9 && first.costUsd === 0.0123, String(totalCost(builtRun)));
  check('I2. the cost line names the map term with the build cost and no "not recorded" note', costLine(builtRun) === `Cost: $${(oldTotal + 0.0123).toFixed(4)} total (planner $0.0336, explorer $5.9386, critic $0.1189, map $0.0123)`, costLine(builtRun));
  const reusedRun = { cost: { ...base, requirementsUsd: second.costUsd } };
  check('I3. a reused map adds 0 to the total and the line shows map $0.0000', second.costUsd === 0 && Math.abs(totalCost(reusedRun) - oldTotal) < 1e-9 && costLine(reusedRun) === `Cost: $${oldTotal.toFixed(4)} total (planner $0.0336, explorer $5.9386, critic $0.1189, map $0.0000)`, costLine(reusedRun));
  const olderRun = { cost: base };
  check('I4. a report with no requirementsUsd key keeps its old total and the line says the map cost is not recorded', !hasRequirementsCost(olderRun) && Math.abs(totalCost(olderRun) - oldTotal) < 1e-9 && costLine(olderRun) === `Cost: $6.0911 total (planner $0.0336, explorer $5.9386, critic $0.1189) ${REQUIREMENTS_COST_NOT_RECORDED}` && REQUIREMENTS_COST_NOT_RECORDED === '(requirements map cost not recorded on this report)', costLine(olderRun));
  const stabilizerRun = { cost: { ...base, requirementsUsd: 0.0048 }, stability: { stabilizerCostUsd: 0.25 } };
  check('I5. the stabilizer term counts in the total (as the index always did) and is named on the line only when it spent something', Math.abs(totalCost(stabilizerRun) - (oldTotal + 0.0048 + 0.25)) < 1e-9 && costLine(stabilizerRun).includes(', stabilizer $0.2500, map $0.0048)') && !costLine({ cost: base, stability: { stabilizerCostUsd: 0 } }).includes('stabilizer'), costLine(stabilizerRun));
  check('I6. the gateway summary prints the same line as the CLI (one costLine)', summarize({ ...olderRun, scenarios: [], url: 'https://x.example/', language: 'ts', cascadeStats: {} as never, steps: 0, startedAt: '', finishedAt: '' } as RunReport)[0] === costLine(olderRun));
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: SRS loading caps and rejects correctly, the requirements parser recovers fenced/prose responses and fails loud on malformed ones, and the map is cached by SRS content hash (reused, rebuilt on the flag, rebuilt on a changed byte).');
