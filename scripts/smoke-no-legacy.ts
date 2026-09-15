/**
 * Locks the retirement of the single-file UI (dashboard v2 plan, PR E2): no
 * file in the repository references qa-core-ui.html or the /legacy route.
 * Scanned: every tracked-shape file under the repo except build output, run
 * output, dependencies, and the two planning records that describe the
 * retirement itself (STATE.md, docs/dashboard-v2-plan.md). This script is
 * excluded from its own scan.
 */
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

const root = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', 'output', '.git', 'eval-results', 'test-results', 'playwright-report', 'data', '.qa-core', 'playwright']);
const SKIP_FILES = new Set([path.join('STATE.md'), path.join('docs', 'dashboard-v2-plan.md'), path.join('scripts', 'smoke-no-legacy.ts'), 'package-lock.json', 'repomix-output.xml']);
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|html|css|svg|sh|yml|yaml|txt)$/i;
// The retired route only: not a host such as legacy.example, a folder such as legacy-automation-framework, or the status word legacy.
const LEGACY_ROUTE = /\/legacy(?=$|[\s'"`)\/,;?#])/;
const hits: string[] = [];
let scanned = 0;
const walk = (dir: string): void => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(root, full);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name) && !name.startsWith('.claude-')) walk(full); continue; }
    if (SKIP_FILES.has(rel) || !TEXT.test(name)) continue;
    scanned++;
    const text = fs.readFileSync(full, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (line.includes('qa-core-ui.html') || LEGACY_ROUTE.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
};
walk(root);
check(`A. no file references qa-core-ui.html or the /legacy route (${scanned} files scanned)`, hits.length === 0, '\n  ' + hits.join('\n  '));
check('B. the single-file UI is gone from the tree', !fs.existsSync(path.join(root, 'qa-core-ui.html')));
check('C. the retired legacy smokes are gone', ['smoke-ui.ts', 'smoke-ui-pipeline.ts', 'smoke-live-gateway-ui.ts'].every((f) => !fs.existsSync(path.join(root, 'scripts', f))));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: nothing references the retired single-file UI or its /legacy route.');
