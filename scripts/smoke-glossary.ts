/**
 * Locks the dashboard glossary and the design tokens (PR F, part 1):
 *   - every glossary key a page uses (`term="<key>"` in dashboard/src, or a
 *     quoted key in a status or model map) exists in lib/glossary.ts
 *   - every glossary entry is preceded by a `// Source:` comment naming where
 *     the term is defined (an invariant number, or a file and function)
 *   - every entry is one or two sentences of plain copy: no em dash, no en
 *     dash, no double hyphen
 *   - no entry is dead: each key is referenced by at least one page
 *   - every text and status colour in src/index.css keeps at least 4.5:1
 *     against bg-0, bg-1, bg-2 and its own soft tint, in both themes, and
 *     the brand button's text against the brand colour
 * Static: reads the source files. No gateway, no browser, no model.
 */
import fs from 'node:fs';
import path from 'node:path';
import { GLOSSARY } from '../dashboard/src/lib/glossary.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

const repo = process.cwd();
const srcDir = path.join(repo, 'dashboard', 'src');
const glossaryPath = path.join(srcDir, 'lib', 'glossary.ts');
const glossarySrc = fs.readFileSync(glossaryPath, 'utf8');
const keys = Object.keys(GLOSSARY);

/* ─── A. every entry has a Source comment ─── */
const lines = glossarySrc.split('\n');
const missingSource: string[] = [];
const entryLine = /^\s{2}([A-Za-z][A-Za-z0-9]*):\s*\{\s*term:/;
for (let i = 0; i < lines.length; i++) {
  const m = entryLine.exec(lines[i]!);
  if (!m) continue;
  const prev = lines[i - 1] ?? '';
  const named = /^\s{2}\/\/ Source: .+/.test(prev) && (/invariant \d+/.test(prev) || /\.(ts|tsx|md|sql)\b/.test(prev));
  if (!named) missingSource.push(m[1]!);
}
check(`A. every glossary entry (${keys.length}) is preceded by a "// Source:" comment naming an invariant or a file`, missingSource.length === 0 && keys.length > 0, missingSource.join(', '));

/* ─── B. every key the UI uses exists ─── */
const walk = (dir: string): string[] => fs.readdirSync(dir).flatMap((n) => { const f = path.join(dir, n); return fs.statSync(f).isDirectory() ? walk(f) : /\.tsx?$/.test(n) && f !== glossaryPath ? [f] : []; });
const files = walk(srcDir);
const used = new Map<string, string[]>();
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const rel = path.relative(repo, f);
  for (const m of text.matchAll(/\bterm="([A-Za-z][A-Za-z0-9]*)"/g)) used.set(m[1]!, [...(used.get(m[1]!) ?? []), rel]);
  // Keys named in a map value or a fallback, e.g. STATUS_TERM or MODEL_TERM: `: 'statusStopped'` / `?? 'modelPlan'`.
  for (const m of text.matchAll(/(?::|\?\?)\s*'([A-Za-z][A-Za-z0-9]*)'/g)) if (keys.includes(m[1]!)) used.set(m[1]!, [...(used.get(m[1]!) ?? []), rel]);
}
const unknown = [...used.keys()].filter((k) => !keys.includes(k));
check(`B. every glossary key a page uses (${used.size}) exists in glossary.ts`, unknown.length === 0, unknown.map((k) => `${k} in ${used.get(k)!.join(', ')}`).join('; '));

/* ─── C. copy rules ─── */
const badCopy: string[] = [];
for (const [k, e] of Object.entries(GLOSSARY)) {
  const text = `${e.term} ${e.text}`;
  if (/[—–]/.test(text) || /--/.test(text)) badCopy.push(`${k}: dash`);
  const sentences = e.text.trim().split(/[.!?](?:\s+|$)/).filter((s) => s.trim().length > 0).length;
  if (sentences > 2) badCopy.push(`${k}: ${sentences} sentences`);
  if (!e.term.trim() || !e.text.trim()) badCopy.push(`${k}: empty`);
}
check('C. every entry is one or two sentences with no em dash, en dash or double hyphen', badCopy.length === 0, badCopy.join('; '));

/* ─── D. no dead entries, and no "n/a" entry: a value the index does not have is not rendered as a metric ─── */
const dead = keys.filter((k) => !used.has(k));
check('D. every glossary entry is referenced by at least one page', dead.length === 0, dead.join(', '));
check('D2. no entry defines or mentions "n/a" (the pages render a missing value in words, never as n/a)', !Object.values(GLOSSARY).some((e) => /\bn\/a\b/.test(`${e.term} ${e.text}`)) && !keys.includes('notAvailable'));

/* ─── E. token contrast in both themes ─── */
const css = fs.readFileSync(path.join(srcDir, 'index.css'), 'utf8');
const block = (selector: string): Record<string, [number, number, number]> => {
  const m = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
  const out: Record<string, [number, number, number]> = {};
  for (const line of (m?.[1] ?? '').split('\n')) {
    const v = /--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/.exec(line);
    if (v) out[v[1]!] = [Number(v[2]), Number(v[3]), Number(v[4])];
  }
  return out;
};
const hsl2rgb = ([h, s, l]: [number, number, number]): [number, number, number] => { s /= 100; l /= 100; const k = (n: number) => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as [number, number, number]; };
const lum = ([r, g, b]: [number, number, number]): number => { const m = [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!; };
const ratio = (a: [number, number, number], b: [number, number, number]): number => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (fg: [number, number, number], bg: [number, number, number], a: number): [number, number, number] => fg.map((v, i) => Math.round(v * a + bg[i]! * (1 - a))) as [number, number, number];
const TEXT = ['text', 'text-2', 'text-3'];
const STATUS = ['accent', 'pass', 'rework', 'reject', 'finding', 'neutral', 'cost'];
const SURFACES = ['bg-0', 'bg-1', 'bg-2', 'bg-3'];
for (const theme of [':root', '.light']) {
  const t = block(theme);
  const c = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, hsl2rgb(v)])) as Record<string, [number, number, number]>;
  const weak: string[] = [];
  let pairs = 0;
  const test = (fg: string, bgName: string, bg: [number, number, number]) => { pairs++; const r = ratio(c[fg]!, bg); if (r < 4.5) weak.push(`${fg} on ${bgName} ${r.toFixed(2)}`); };
  for (const fg of TEXT) for (const bg of SURFACES) test(fg, bg, c[bg]!);
  for (const fg of STATUS) { for (const bg of SURFACES.slice(0, 3)) test(fg, bg, c[bg]!); test(fg, `${fg}-soft`, mix(c[fg]!, c['bg-1']!, 0.12)); }
  test('brand-fg', 'brand', c.brand!);
  const required = [...TEXT, ...STATUS, 'brand', 'brand-fg', ...SURFACES].filter((k) => !c[k]);
  check(`E. ${theme === ':root' ? 'dark' : 'light'}: every text and status colour keeps at least 4.5:1 on its surfaces (${pairs} pairs)`, weak.length === 0 && required.length === 0, [...weak, ...required.map((k) => `missing --${k}`)].join('; '));
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: every glossary key the dashboard uses exists with a named source and plain copy, and every token pair keeps 4.5:1 in both themes.');
