/**
 * Print a run's recorded scenarios exactly as the Critic would now receive
 * them, $0, read only:
 *
 *   npx tsx scripts/critic-input.ts <run dir>
 *
 * Reads <run dir>/run-report.json and renders every shipped scenario
 * (`scenarios`) and every dropped trace (`droppedTraces`, with its repair
 * recording when one exists) through criticUserMessage, the function the
 * Critic call itself uses, so each step line comes from describeStep. Every
 * line is masked with the run-report's credential masking (maskString over
 * the env's test-account values and the report's recorded login values)
 * before it prints.
 *
 * No model call: ANTHROPIC_API_KEY is removed from this process's environment
 * before anything runs. Nothing is written, under output/ or anywhere else.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { criticUserMessage } from '../src/agent/critic.js';
import { envCredentialValues, maskString } from '../src/agent/credential-leak.js';
import { credentialSecrets } from '../src/agent/datasets.js';
import type { RunReport, Scenario } from '../src/agent/trace.js';

delete process.env.ANTHROPIC_API_KEY;

const USAGE = 'usage: npx tsx scripts/critic-input.ts <run dir>';

function refuse(message: string): never {
  console.error(message);
  process.exit(2);
}

const arg = process.argv[2];
if (!arg || arg.startsWith('--')) refuse(USAGE);
const reportPath = path.join(path.resolve(arg), 'run-report.json');
if (!fs.existsSync(reportPath)) refuse(`no run-report.json at ${reportPath}`);

let report: RunReport;
try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as RunReport;
} catch (e) {
  refuse(`run-report.json at ${reportPath} is not valid JSON: ${(e as Error).message}`);
}

const secrets = [...new Set([...envCredentialValues(), ...credentialSecrets(report)])].sort((a, b) => b.length - a.length);
const out = (text: string): void => { console.log(maskString(text, secrets)); };

out(`Critic input for ${reportPath}, rendered at $0 (describeStep, credential-masked).`);
out('');

const shipped = report.scenarios ?? [];
out(`== scenarios: ${shipped.length} shipped ==`);
out(shipped.length ? criticUserMessage(shipped, report.url) : '(none)');

const dropped = report.droppedTraces ?? [];
out('');
out(`== droppedTraces: ${dropped.length} ==`);
if (dropped.length === 0) out(report.droppedTraces ? '(none)' : '(no droppedTraces key on this report)');
dropped.forEach((t, i) => {
  const header = `-- drop ${i + 1} of ${dropped.length}: stage ${t.stage}${t.recordedName ? `, recorded as "${t.recordedName}"` : ''}: ${t.reason}`;
  out('');
  out(header);
  const category = (t.category ?? 'unknown') as Scenario['category'];
  if (t.steps.length === 0) out(`(no trace: ${t.noTrace ?? 'no steps recorded'})`);
  else out(criticUserMessage([{ name: t.name, category, steps: t.steps }], report.url));
  if (t.repairSteps && t.repairSteps.length > 0) {
    out(`-- repair recording of drop ${i + 1}:`);
    out(criticUserMessage([{ name: t.name, category, steps: t.repairSteps }], report.url));
  }
});
