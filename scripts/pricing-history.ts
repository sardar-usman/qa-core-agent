/**
 * pricing-history: what the old per-stage prices did to the recorded costs
 * of past runs (invariant 74). $0, read only: it reads run-report.json and
 * run-meta.json under output/practicesoftwaretesting-com/ and
 * output/saucedemo-com/ and never writes anything. History is never
 * re-priced; this table is for the owner to decide on an erratum.
 *
 * Before the price table, the Stabilizer priced any model whose id held
 * "opus" at 15/75, "haiku" at 1/5 and anything else at 3/15, and counted no
 * cache tokens. A report stores the Stabilizer's dollars, not its tokens, so
 * the correct price is recomputed by the ratio of the table's rate to the old
 * one. That ratio is the same for input and output on every model (Opus 4.7:
 * 5/15 = 25/75, Sonnet 4.6: 3/3 = 15/15, Haiku 4.5: 1/1 = 5/5), so the
 * rescale is exact on the tokens the old estimate counted. The cache tokens
 * it never counted were never recorded, so they cannot be recovered.
 *
 * The Critic, the Planner, the requirements map and the page filter were
 * priced at their default model's input and output rates and also counted no
 * cache tokens. A run that overrode one of those models would have been
 * priced wrongly; the script names any override run-meta.json recorded.
 *
 *   npx tsx scripts/pricing-history.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { MODEL_PRICES } from '../src/agent/pricing.js';
import { STAGE_MODELS } from '../src/agent/stage-models.js';

const PROJECTS = ['output/practicesoftwaretesting-com', 'output/saucedemo-com'];

/** The pre-table Stabilizer rate (stabilizer.ts estimateCost at main b131acd), input and output per million. */
function oldStabilizerRate(model: string): { in: number; out: number } {
  if (/opus/i.test(model)) return { in: 15, out: 75 };
  if (/haiku/i.test(model)) return { in: 1, out: 5 };
  return { in: 3, out: 15 };
}

interface Row { run: string; recorded: number; model: string; modelSource: string; correct: number | null; overrides: string[] }

const rows: Row[] = [];
for (const project of PROJECTS) {
  if (!fs.existsSync(project)) continue;
  for (const name of fs.readdirSync(project).sort()) {
    const dir = path.join(project, name);
    const reportPath = path.join(dir, 'run-report.json');
    // Run directories only: the latest pointer (a symlink) and the srs folder are not runs.
    if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory() || !fs.existsSync(reportPath)) continue;
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as { stability?: { stabilizerCostUsd?: number }; cost?: { models?: Record<string, string> } };
    let env: Record<string, string> = {};
    try { env = (JSON.parse(fs.readFileSync(path.join(dir, 'run-meta.json'), 'utf8')) as { flags?: { env?: Record<string, string> } }).flags?.env ?? {}; } catch { /* no run-meta: nothing recorded */ }
    const recordedModel = report.cost?.models?.stabilizer ?? env.QA_CORE_MODEL_STABILIZER;
    const model = recordedModel ?? STAGE_MODELS.stabilizer.defaultModel;
    const modelSource = report.cost?.models?.stabilizer ? 'report' : env.QA_CORE_MODEL_STABILIZER ? 'run-meta' : 'code default, no override recorded';
    const recorded = report.stability?.stabilizerCostUsd ?? 0;
    const table = MODEL_PRICES[model];
    const old = oldStabilizerRate(model);
    const correct = table && table.in / old.in === table.out / old.out ? recorded * (table.in / old.in) : null;
    const overrides = Object.entries(env).filter(([k]) => /MODEL/.test(k)).map(([k, v]) => `${k}=${v}`);
    rows.push({ run: `${path.basename(project)}/${name}`, recorded, model, modelSource, correct, overrides });
  }
}

const usd = (v: number): string => `$${v.toFixed(6)}`;
console.log('| Run | Recorded Stabilizer cost | Stabilizer model | Correct price on the recorded tokens | Difference | Model overrides recorded |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) {
  const correct = r.correct === null ? 'not computable' : usd(r.correct);
  const diff = r.correct === null ? 'n/a' : usd(r.correct - r.recorded);
  console.log(`| ${r.run} | ${usd(r.recorded)} | ${r.model} (${r.modelSource}) | ${correct} | ${diff} | ${r.overrides.length ? r.overrides.join(', ') : 'none'} |`);
}
const total = rows.reduce((n, r) => n + r.recorded, 0);
const totalCorrect = rows.reduce((n, r) => n + (r.correct ?? r.recorded), 0);
console.log(`\n${rows.length} runs; recorded Stabilizer total ${usd(total)}; correct on the recorded tokens ${usd(totalCorrect)}; difference ${usd(totalCorrect - total)}.`);
console.log(`Runs with a model override recorded in run-meta.json: ${rows.filter((r) => r.overrides.length).length}.`);
console.log('Cache tokens: the Stabilizer, Critic, Planner, requirements map and page filter never recorded their cache read or write tokens, so their cache spend is missing from every report above and cannot be recovered.');
