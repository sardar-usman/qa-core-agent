/**
 * Replay a run's console from its events.jsonl through the CLI's own
 * renderer (src/cli/render.ts), $0, read only:
 *
 *   npx tsx scripts/render-events.ts <events.jsonl> [--stages N] [--no-replay]
 *
 * Prints what `npm run explore` printed for those events (the transient
 * thinking and spend ticker left out). smoke-console-honesty spawns it to
 * lock that no message is dropped (invariant 72).
 */
import fs from 'node:fs';
import { createEventRenderer } from '../src/cli/render.js';
import type { AgentEvent } from '../src/agent/runtime.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--stages');
if (!file) {
  console.error('usage: npx tsx scripts/render-events.ts <events.jsonl> [--stages N] [--no-replay]');
  process.exit(2);
}
const stagesAt = args.indexOf('--stages');
const totalStages = stagesAt >= 0 ? Number(args[stagesAt + 1]) : 5;
const render = createEventRenderer({ totalStages, replay: !args.includes('--no-replay'), log: (line) => console.log(line) });
for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!raw.trim()) continue;
  // appendRunEvent stores the event flat, with its time as `t`.
  render(JSON.parse(raw) as AgentEvent);
}
