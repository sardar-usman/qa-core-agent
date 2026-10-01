/**
 * Locks the per-host memory of the test-id attribute (src/agent/memory.ts).
 *
 * Run 51d535 waited 59 s twice on a data-testid css against a data-test
 * site, a convention run 4 had already seen. Now:
 *
 *   - saveRun records the dominant attribute on the host fingerprint
 *     (.qa-core/sites/<host>.json, `testIdAttribute`)
 *   - renderMemoryBlock states it ("This host uses data-test ...")
 *   - a later run that saw no attribute keeps the remembered one, and one
 *     that saw another replaces it
 *   - the live summary helpers agree: dominantTestIdAttribute and the first
 *     line of a get_dom result name the same attribute
 *
 * Runs in a temporary working directory so no real fingerprint is touched.
 * No network. No LLM.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveRun, loadSiteFingerprint, renderMemoryBlock } from '../src/agent/memory.js';
import { dominantTestIdAttribute, testIdAttributeLine } from '../src/agent/tools.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

const originalCwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-host-memory-'));
process.chdir(tmp);
try {
  const url = 'https://www.practicesoftwaretesting.com/';
  const base = {
    url,
    scenarios: 3,
    cost: 0.5,
    model: 'test-model',
    durationSec: 10,
    cascadeStats: { role: 1, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 2, css: 1, xpath: 0 },
    resolvedIntents: [{ intent: 'login button', level: 'role' as const }],
  };

  saveRun({ ...base, testIdAttribute: 'data-test' });
  const first = loadSiteFingerprint(url);
  check('A. the fingerprint records the test-id attribute the run saw', first?.testIdAttribute === 'data-test', JSON.stringify(first));
  check('B. the fingerprint file lives under .qa-core/sites/<host>.json', fs.existsSync(path.join(tmp, '.qa-core', 'sites', 'www.practicesoftwaretesting.com.json')));

  const block = renderMemoryBlock(url) ?? '';
  check('C. the memory block states the attribute for the next run', /This host uses data-test as its test-id attribute/.test(block) && /\[data-test="\.\.\."\]/.test(block), block);

  saveRun({ ...base, testIdAttribute: null });
  check('D. a run that saw no attribute keeps the remembered one', loadSiteFingerprint(url)?.testIdAttribute === 'data-test');

  saveRun({ ...base, testIdAttribute: 'data-testid' });
  check('E. a run that saw another attribute replaces it', loadSiteFingerprint(url)?.testIdAttribute === 'data-testid');
  check('F. the memory block follows the fingerprint', /This host uses data-testid as its test-id attribute/.test(renderMemoryBlock(url) ?? ''));

  const other = 'https://other.example/';
  saveRun({ ...base, url: other });
  const fresh = loadSiteFingerprint(other);
  check('G. a host that never saw either attribute has no field, and its memory block does not mention one', fresh !== null && !('testIdAttribute' in fresh) && !/test-id attribute/.test(renderMemoryBlock(other) ?? ''), JSON.stringify(fresh));

  check('H. dominantTestIdAttribute picks the attribute seen most, null when none was seen',
    dominantTestIdAttribute({ _testIdCounts: { 'data-testid': 2, 'data-test': 41 } }) === 'data-test'
    && dominantTestIdAttribute({ _testIdCounts: { 'data-testid': 0, 'data-test': 0 } }) === null
    && dominantTestIdAttribute({ _testIdCounts: {} }) === null);
  check('I. the get_dom first line names the same attribute',
    testIdAttributeLine({ 'data-testid': 0, 'data-test': 41 }) === 'test-id attribute on this page: data-test'
    && testIdAttributeLine({ 'data-testid': 2, 'data-test': 41 }) === 'test-id attribute on this page: data-test (data-testid also appears on 2 element(s))'
    && testIdAttributeLine({ 'data-testid': 0, 'data-test': 0 }) === 'test-id attribute on this page: none');
} finally {
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the per-host fingerprint records the test-id attribute, the memory block states it, a run that saw none keeps it, and the get_dom line agrees.');
