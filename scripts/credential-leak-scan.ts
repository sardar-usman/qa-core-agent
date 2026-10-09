/**
 * Credential leak scan ($0, READ ONLY): every run folder under output/ and
 * every zip in it, searched for the Toolshop and saucedemo public demo
 * passwords and for the current test-account env values when set
 * (QA_CORE_TEST_USER* / QA_CORE_TEST_PASS*, read from .env like a run reads
 * them). Prints the file, the field (a JSON path, "line N: <path>" in a JSON
 * lines file, or "line N") and the count for every hit, and which secret
 * matched by its NAME. Never prints a value, and never writes or modifies a
 * file (CLAUDE.md invariant 70).
 *
 *   npx tsx scripts/credential-leak-scan.ts [output-dir]
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { secretsInText } from '../src/agent/credential-leak.js';

const root = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'output'));

// The public demo passwords the audit runs typed: Toolshop's documented
// customer account and saucedemo's shared password.
const secrets: Array<{ label: string; value: string }> = [
  { label: 'toolshop demo password', value: 'welcome01' },
  { label: 'saucedemo demo password', value: 'secret_sauce' },
];
for (const [name, value] of Object.entries(process.env)) {
  if (!/^QA_CORE_TEST_(?:USER|PASS)(?:_[A-Z0-9_]+)?$/.test(name) || typeof value !== 'string' || value === '') continue;
  // A value already searched (an env pair holding a demo account) is named on that row.
  const same = secrets.find((s) => s.value === value);
  if (same) same.label = `${same.label}, the same value as env ${name}`;
  else secrets.push({ label: `env ${name}`, value });
}

interface Hit { file: string; field: string; count: number; secret: string }
const hits: Hit[] = [];
const TEXT_EXT = /\.(json|jsonl|md|txt|ts|js|csv|html|yml|yaml|example|gitignore)$/i;

function scanText(file: string, text: string): void {
  for (const s of secrets) {
    for (const h of secretsInText(file, text, [s.value])) hits.push({ file, field: h.field, count: h.count, secret: s.label });
  }
}

function scanZip(abs: string, rel: string): void {
  const list = spawnSync('unzip', ['-Z1', abs], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (list.status !== 0) { console.log(`could not list ${rel}: ${list.stderr.trim()}`); return; }
  for (const entry of list.stdout.split('\n').filter((e) => e && !e.endsWith('/'))) {
    const out = spawnSync('unzip', ['-p', abs, entry], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (out.status !== 0) continue;
    scanText(`${rel}!${entry}`, out.stdout);
  }
}

function walk(dir: string): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs);
    if (e.isSymbolicLink()) continue; // output/<project>/latest points at a run already walked
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(abs); continue; }
    if (!e.isFile()) continue;
    if (e.name.endsWith('.zip')) { scanZip(abs, rel); continue; }
    if (!TEXT_EXT.test(e.name) && e.name !== '.env.example') continue;
    let text: string;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    scanText(rel, text);
  }
}

if (!fs.existsSync(root)) {
  console.log(`no output directory at ${root}; nothing scanned`);
  process.exit(0);
}
walk(root);

console.log(`credential leak scan of ${path.relative(process.cwd(), root) || root} (read only)`);
console.log(`secrets searched: ${secrets.map((s) => s.label).join('; ')}`);
console.log('');
if (hits.length === 0) {
  console.log('no hits');
} else {
  for (const h of hits) console.log(`${h.file}  ${h.field}  count=${h.count}  (${h.secret})`);
  console.log('');
  const byRun = new Map<string, number>();
  for (const h of hits) {
    const run = h.file.split(/[\\/]/).slice(0, 2).join('/');
    byRun.set(run, (byRun.get(run) ?? 0) + h.count);
  }
  console.log(`${hits.length} field(s) hold a secret, ${hits.reduce((n, h) => n + h.count, 0)} occurrence(s) in all, by run folder:`);
  for (const [run, n] of byRun) console.log(`  ${run}: ${n}`);
}
