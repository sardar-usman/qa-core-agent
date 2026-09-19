/**
 * The whole smoke suite, discovered from disk. Every scripts/smoke-*.ts is
 * run, sorted, one at a time, with no hardcoded list anywhere: the old
 * for-loop in CLAUDE.md named 70 scripts while 82 sat on disk, so twelve
 * locks were never run by "the full suite".
 *
 * A script PASSES only when its exit code is 0 AND its last non-empty stdout
 * line starts with "OK:". Exit code 0 with no OK line is a FAILURE reported
 * as "no OK line": a failure must never look like a pass. The runner prints
 * one progress line per script, a final table, the last 20 lines of every
 * failure's output, and "N smokes, P passed, F failed", and exits non-zero
 * when anything failed.
 *
 *   npm run smoke
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const scriptsDir = path.join(repo, 'scripts');
const self = path.basename(fileURLToPath(import.meta.url));
const tsxBin = path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

const files = fs.readdirSync(scriptsDir)
  .filter((f) => /^smoke-.*\.ts$/.test(f) && f !== self)
  .sort();

interface Result { name: string; pass: boolean; reason: string; ms: number; tail: string[] }

function run(file: string): Promise<Result> {
  const name = file.replace(/\.ts$/, '');
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(tsxBin, [path.join(scriptsDir, file)], { cwd: repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => {
      const ms = Date.now() - start;
      const lines = stdout.split('\n').map((l) => l.trimEnd());
      const lastNonEmpty = [...lines].reverse().find((l) => l.trim().length > 0) ?? '';
      const okLine = lastNonEmpty.startsWith('OK:');
      let pass = false;
      let reason = '';
      if (code === 0 && okLine) { pass = true; reason = 'OK'; }
      else if (code === 0) reason = 'no OK line';
      else reason = `exit ${String(code)}${okLine ? '' : ', no OK line'}`;
      const combined = (stdout + (stderr ? '\n[stderr]\n' + stderr : '')).split('\n').map((l) => l.trimEnd()).filter((l, i, a) => l.length > 0 || i === a.length - 1);
      resolve({ name, pass, reason, ms, tail: combined.slice(-20) });
    });
  });
}

const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

console.log(`smoke-all: ${files.length} scripts discovered in scripts/ (smoke-*.ts, sorted)`);
const results: Result[] = [];
for (const [i, file] of files.entries()) {
  const r = await run(file);
  results.push(r);
  console.log(`[${String(i + 1).padStart(2)}/${files.length}] ${r.pass ? 'pass' : 'FAIL'}  ${r.name.padEnd(34)} ${fmtMs(r.ms).padStart(8)}${r.pass ? '' : `  (${r.reason})`}`);
}

const nameWidth = Math.max(...results.map((r) => r.name.length), 4);
console.log('');
console.log(`${'name'.padEnd(nameWidth)}  result  duration`);
console.log(`${'-'.repeat(nameWidth)}  ------  --------`);
for (const r of results) console.log(`${r.name.padEnd(nameWidth)}  ${r.pass ? 'pass  ' : 'FAIL  '}  ${fmtMs(r.ms).padStart(8)}${r.pass ? '' : `  ${r.reason}`}`);

const failed = results.filter((r) => !r.pass);
for (const r of failed) {
  console.log(`\n=== ${r.name}: ${r.reason}; last ${r.tail.length} line(s) of output ===`);
  for (const l of r.tail) console.log(`  ${l}`);
}

const passed = results.length - failed.length;
console.log(`\n${results.length} smokes, ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
