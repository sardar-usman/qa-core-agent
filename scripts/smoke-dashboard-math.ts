/**
 * Locks invariant 7: per-site pass-rate math divides by the runs that have a
 * pass rate (runsWithPass), never by the total run count. The aggregate lives
 * in src/server/runs.ts (sitePassRates), the shared home of the math the
 * retired single-file UI rendered. Checked against synthetic runs and, when
 * this checkout has runs on disk, against listRunsFromDisk.
 */
import { listRunsFromDisk, sitePassRates } from '../src/server/runs.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

const synthetic = [
  { host: 'a.example', passRate: 100 },
  { host: 'a.example', passRate: null },
  { host: 'a.example', passRate: null },
  { host: 'a.example', passRate: null },
  { host: 'b.example', passRate: 50 },
  { host: 'b.example', passRate: 100 },
  { host: 'c.example', passRate: null },
];
const sites = sitePassRates(synthetic);
const a = sites.find((s) => s.host === 'a.example')!;
const b = sites.find((s) => s.host === 'b.example')!;
const c = sites.find((s) => s.host === 'c.example')!;
check('A. one measured run out of four: the average is that run (100), not a quarter of it (25)', a.runs === 4 && a.runsWithPass === 1 && a.avgPassRate === 100, JSON.stringify(a));
check('B. two measured runs average over two', b.runs === 2 && b.runsWithPass === 2 && b.avgPassRate === 75, JSON.stringify(b));
check('C. no measured run: null, never 0', c.runs === 1 && c.runsWithPass === 0 && c.avgPassRate === null, JSON.stringify(c));
check('D. sites are sorted by host and every site appears once', sites.map((s) => s.host).join(',') === 'a.example,b.example,c.example');
check('E. a run without a host lands under "(no host)"', sitePassRates([{ host: null, passRate: 20 }])[0]?.host === '(no host)');

const real = listRunsFromDisk(process.cwd());
const realSites = sitePassRates(real);
check('F. on this checkout\'s runs, every site divides by its own measured count and never reports 0 for an unmeasured site', realSites.every((s) => s.runsWithPass <= s.runs && (s.runsWithPass > 0 ? s.avgPassRate !== null : s.avgPassRate === null)), JSON.stringify(realSites));
console.log(`  (this checkout: ${real.length} run(s) on disk across ${realSites.length} site(s), ${realSites.filter((s) => s.runsWithPass > 0).length} with a measured pass rate)`);

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: dashboard per-site pass-rate math divides by runsWithPass, not total runs.');
