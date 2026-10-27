/**
 * Emit a fixture report as a framework and run it with Playwright, for the
 * locks that must see an emitted assertion go red or green (standing rule 4:
 * compiled is not executed). Shared by smoke-all-items, smoke-dataset-errors
 * and smoke-absence-testid.
 *
 * Each framework is written to its own temporary directory with this repo's
 * node_modules linked in, so no npm install runs. Playwright is spawned
 * asynchronously, so the calling process keeps serving its fixture pages.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { scaffold } from '../../src/agent/scaffold.js';
import { transcribe } from '../../src/agent/transcriber.js';
import type { RunReport } from '../../src/agent/trace.js';

export type Shape = 'POM' | 'single file';

export interface Emitted {
  language: 'ts' | 'js';
  shape: Shape;
  dir: string;
  /** Every file the emitter wrote, relative path to contents (node_modules excluded). */
  files: Map<string, string>;
  /** Dataset notes from the POM emitter (empty for a single file). */
  datasetNotes: string[];
}

/** Write the report as a framework of the given shape into a fresh temporary directory. */
export function emitFramework(report: RunReport, shape: Shape, tag: string): Emitted {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qa-${tag}-${shape === 'POM' ? 'pom' : 'single'}-${report.language}-`));
  let datasetNotes: string[] = [];
  if (shape === 'POM') datasetNotes = scaffold({ report, outDir: dir, siteName: `${tag}-fixture` }).pomResult.datasetNotes;
  else transcribe({ report, outDir: dir, name: tag });
  const files = readTree(dir);
  fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return { language: report.language, shape, dir, files, datasetNotes };
}

/** Every file under dir (relative path to contents), node_modules excluded. */
export function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(path.relative(dir, full), fs.readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

/**
 * The emitted lines that assert an empty text, or the old dataset fallback:
 * toContainText('') / toHaveText('') in either quote style, and
 * toContainText(c.errorText ?? '') (run 59540f D7b). Empty when clean.
 */
export function emptyTextHits(files: Map<string, string>): string[] {
  const re = /to(?:Contain|Have)Text\(\s*(?:''|""|``|c\.errorText \?\? '')/;
  const hits: string[] = [];
  for (const [file, text] of files) {
    text.split('\n').forEach((line, i) => { if (re.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`); });
  }
  return hits;
}

export interface SpecResult { title: string; status: string; error: string }

interface PwSuite { specs?: Array<{ title: string; tests: Array<{ status: string; results?: Array<{ error?: { message?: string } }> }> }>; suites?: PwSuite[] }

function walk(suites: PwSuite[] = []): SpecResult[] {
  return suites.flatMap((su) => [
    ...(su.specs ?? []).map((sp) => ({
      title: sp.title,
      status: sp.tests[0]?.status ?? 'missing',
      error: (sp.tests[0]?.results?.[0]?.error?.message ?? '').replace(/\u001b\[[0-9;]*m/g, ''),
    })),
    ...walk(su.suites),
  ]);
}

/**
 * Run Playwright in the framework directory (chromium, the JSON reporter,
 * no retries) on the tests whose title matches grep. Returns the exit status,
 * the tail of the output and every spec's status ('expected' is a pass,
 * 'unexpected' a failure). A run past 180 s is killed and says so.
 */
export function runPlaywright(dir: string, grep: string): Promise<{ status: number | null; out: string; specs: SpecResult[] }> {
  return new Promise((resolve) => {
    const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: 'results.json' } as NodeJS.ProcessEnv;
    delete env.CI;
    const child = spawn('npx', ['playwright', 'test', '--reporter=json', '--workers=2', '--retries=0', '--grep', grep], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); out += '\n(killed after 180s)'; }, 180_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      const jsonPath = path.join(dir, 'results.json');
      let specs: SpecResult[] = [];
      try {
        specs = fs.existsSync(jsonPath) ? walk((JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as { suites?: PwSuite[] }).suites) : [];
      } catch (e) {
        out += `\n(results.json did not parse: ${(e as Error).message})`;
      }
      resolve({ status, out: out.slice(-1500), specs });
    });
  });
}

/** Remove the temporary framework directories. */
export function cleanup(dirs: string[]): void {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
