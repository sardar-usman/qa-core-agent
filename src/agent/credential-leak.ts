import fs from 'node:fs';
import path from 'node:path';

/**
 * No test-account value is written under output/ (invariant 70, owner
 * decision E). The credential marker keeps values out of recorded steps;
 * this module covers everything else:
 *
 *   - maskDeep / maskForDisk replace every occurrence of a secret inside any
 *     string (a skip reason the model wrote, a Critic reason, a finding's page
 *     text) with CREDENTIAL_REDACTION before a file is written: the run
 *     directory's run-report.json, checkpoint.json, events.jsonl and the
 *     report copy inside the zip.
 *   - scanForSecrets walks a directory (or a zip's entries) and names every
 *     file and field that still holds a secret, never the value itself. The
 *     surfaces run it on the framework tree and the run directory before the
 *     zip is written; a hit refuses the zip.
 *
 * The secrets are the values of every QA_CORE_TEST_USER* / QA_CORE_TEST_PASS*
 * variable in the environment (the generic pair and every host-scoped pair),
 * so a value is masked whichever pair the run used.
 */

/** The placeholder a masked credential value carries. */
export const CREDENTIAL_REDACTION = '[redacted:credential]';

const SECRET_VAR_RE = /^QA_CORE_TEST_(?:USER|PASS)(?:_[A-Z0-9_]+)?$/;
/** A secret shorter than this is only masked as a whole string, never inside a longer one. */
const MIN_SUBSTRING_LEN = 4;

/** The values of every test-account variable set in env, longest first. */
export function envCredentialValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_VAR_RE.test(k) && typeof v === 'string' && v !== '' && v !== CREDENTIAL_REDACTION) out.add(v);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Every occurrence of a secret in the string, masked. */
export function maskString(s: string, secrets: readonly string[]): string {
  let out = s;
  for (const secret of secrets) {
    if (!secret) continue;
    if (secret.length < MIN_SUBSTRING_LEN) { if (out === secret) out = CREDENTIAL_REDACTION; continue; }
    if (out.includes(secret)) out = out.split(secret).join(CREDENTIAL_REDACTION);
  }
  return out;
}

/** A copy of the value with every string masked; the input is never mutated. */
export function maskDeep<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return maskString(v, secrets);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** maskDeep with the env's test-account values: the form every writer under output/ uses. */
export function maskForDisk<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  return maskDeep(value, envCredentialValues(env));
}

/** How many times a secret occurs in a string. */
function occurrences(s: string, secrets: readonly string[]): number {
  let n = 0;
  for (const secret of secrets) {
    if (!secret) continue;
    if (secret.length < MIN_SUBSTRING_LEN) { if (s === secret) n++; continue; }
    n += s.split(secret).length - 1;
  }
  return n;
}

export interface SecretHit {
  /** The file, relative to the scanned root (a zip entry as <zip>!<entry>). */
  file: string;
  /** Where in the file: a JSON path ($.skipped[0].reason), "line N: $.path" in a JSON lines file, or "line N". */
  field: string;
  count: number;
}

/** Every JSON path whose string value holds a secret. */
export function secretsInJson(value: unknown, secrets: readonly string[], at = '$'): Array<{ field: string; count: number }> {
  const out: Array<{ field: string; count: number }> = [];
  const walk = (v: unknown, p: string): void => {
    if (typeof v === 'string') { const n = occurrences(v, secrets); if (n > 0) out.push({ field: p, count: n }); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, /^[A-Za-z_$][\w$]*$/.test(k) ? `${p}.${k}` : `${p}[${JSON.stringify(k)}]`);
    }
  };
  walk(value, at);
  return out;
}

/** The hits in one file's text, by its kind (JSON, JSON lines, anything else by line). */
export function secretsInText(name: string, text: string, secrets: readonly string[]): Array<{ field: string; count: number }> {
  if (occurrences(text, secrets) === 0) return [];
  if (name.endsWith('.json')) {
    try { return secretsInJson(JSON.parse(text), secrets); } catch { /* not valid JSON: by line below */ }
  }
  const out: Array<{ field: string; count: number }> = [];
  text.split('\n').forEach((line, i) => {
    const n = occurrences(line, secrets);
    if (n === 0) return;
    if (name.endsWith('.jsonl')) {
      try {
        for (const h of secretsInJson(JSON.parse(line), secrets)) out.push({ field: `line ${i + 1}: ${h.field}`, count: h.count });
        return;
      } catch { /* fall through to the plain line */ }
    }
    out.push({ field: `line ${i + 1}`, count: n });
  });
  return out;
}

/** Files under a directory, recursively, relative paths, symlinks not followed. */
function listFiles(dir: string, skip: (rel: string) => boolean, base = dir): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs);
    if (skip(rel)) continue;
    if (e.isDirectory()) out.push(...listFiles(abs, skip, base));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Every file and field under `dir` that holds a secret. `skip` leaves files
 * out by relative path (node_modules, the client's own SRS document).
 */
export function scanDirForSecrets(dir: string, secrets: readonly string[], skip: (rel: string) => boolean = () => false): SecretHit[] {
  if (secrets.length === 0) return [];
  const hits: SecretHit[] = [];
  for (const rel of listFiles(dir, (r) => r.split(path.sep).includes('node_modules') || skip(r))) {
    let text: string;
    try { text = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { continue; }
    for (const h of secretsInText(rel, text, secrets)) hits.push({ file: rel.split(path.sep).join('/'), ...h });
  }
  return hits;
}

/** The SRS documents a run directory holds: the client's own input, never written by the agent's stages. */
export function isSrsSource(rel: string): boolean {
  return /\.(md|txt|pdf|docx)$/i.test(rel) && !rel.includes('/');
}

export class CredentialLeakError extends Error {
  constructor(public readonly hits: SecretHit[]) {
    super(`zip refused: a test-account value was found in ${hits.map((h) => `${h.file} (${h.field})`).join(', ')}; nothing was zipped`);
    this.name = 'CredentialLeakError';
  }
}

/**
 * The guard before every framework zip: the framework tree and the run
 * directory are grepped for each env credential value. A hit throws
 * CredentialLeakError naming each file and field, never the value. The run
 * directory's own SRS document (the client's input) is not the agent's
 * write and is left out; an older zip in the run directory is replaced by
 * this one, so it is left out too.
 */
export function assertNoCredentialLeak(opts: { frameworkDir: string; runDir?: string; env?: NodeJS.ProcessEnv }): void {
  const secrets = envCredentialValues(opts.env ?? process.env);
  if (secrets.length === 0) return;
  const hits = [
    ...scanDirForSecrets(opts.frameworkDir, secrets).map((h) => ({ ...h, file: `framework/${h.file}` })),
    ...(opts.runDir ? scanDirForSecrets(opts.runDir, secrets, (rel) => isSrsSource(rel) || rel.endsWith('.zip')) : []),
  ];
  if (hits.length > 0) throw new CredentialLeakError(hits);
}
