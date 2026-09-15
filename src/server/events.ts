import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from '../agent/runtime.js';

/**
 * Trim an AgentEvent for the dashboard's event stream. Only tool payloads
 * are cut (a get_dom result can be tens of kilobytes); every other event,
 * critic_done and its verdicts included, is forwarded as the runtime emitted
 * it. This runs AFTER the runtime parsed the critic's response, so nothing
 * here can affect what parseVerdicts saw.
 */
export function eventForUi(e: AgentEvent): object {
  if (e.type === 'tool_result') {
    const { data, ...rest } = e;
    const preview = data === undefined ? undefined : JSON.stringify(data).slice(0, 200);
    return preview === undefined ? rest : { ...rest, preview };
  }
  if (e.type === 'tool_call') {
    return { ...e, input: JSON.parse(JSON.stringify(e.input ?? null, (_k, v) => (typeof v === 'string' && v.length > 300 ? v.slice(0, 297) + '...' : v))) };
  }
  return e;
}

/* ─────────────────── Per-run event log ─────────────────── */


/** The events file every surface appends to inside the run directory. */
export const EVENTS_FILE = 'events.jsonl';

/** Events too frequent or too empty to be worth a line on disk. */
const SKIP_ON_DISK = new Set(['thinking_started']);

/**
 * Append one event to <runDir>/events.jsonl as `{ t, ...event }` with tool
 * payloads trimmed the same way the dashboard stream trims them. The file is
 * the stored timeline the Run Detail page renders; the runtime itself never
 * writes it, the surface's onEvent does.
 */
export function appendRunEvent(runDir: string, e: AgentEvent, now: Date = new Date()): void {
  if (SKIP_ON_DISK.has(e.type)) return;
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.appendFileSync(path.join(runDir, EVENTS_FILE), JSON.stringify({ t: now.toISOString(), ...eventForUi(e) }) + '\n');
  } catch { /* a failed log line never fails the run */ }
}

export interface StoredEvent { t: string; type: string; [k: string]: unknown }

/**
 * Append a run-history note that is not an AgentEvent: today only
 * `{ type: 'transcribe', source }` when a surface regenerates the framework.
 * The only write a transcribe makes outside the zip.
 */
export function appendRunNote(runDir: string, note: { type: string; [k: string]: unknown }, now: Date = new Date()): void {
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.appendFileSync(path.join(runDir, EVENTS_FILE), JSON.stringify({ t: now.toISOString(), ...note }) + '\n');
  } catch { /* a failed log line never fails the regenerate */ }
}

/** Read the stored timeline, oldest first. Malformed lines are skipped, never thrown. */
export function readRunEvents(runDir: string, limit = 5000): StoredEvent[] {
  const file = path.join(runDir, EVENTS_FILE);
  if (!fs.existsSync(file)) return [];
  const out: StoredEvent[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as StoredEvent;
      if (ev && typeof ev.type === 'string') out.push(ev);
    } catch { /* skip */ }
  }
  return out.length > limit ? out.slice(out.length - limit) : out;
}
