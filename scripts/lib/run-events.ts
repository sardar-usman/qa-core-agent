/**
 * Reading a run's events.jsonl back into tool calls and scenario
 * recordings. Shared by the read-only evidence scripts
 * (scripts/rework-shapes.ts, scripts/dropped-traces-check.ts) so both cut a
 * recording out of the event log the same way. Reads only; writes nothing.
 */
import fs from 'node:fs';

export interface Call {
  line: number;
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  preview: string | undefined;
  durationMs: number;
}

export interface Segment {
  name: string;
  category: string;
  feature: string | undefined;
  beginLine: number;
  endLine: number;
  calls: Call[];
  /** True when an accepted end_scenario closed it; false when it was abandoned (a gate rejection, a finding, a skip, a later begin_scenario). */
  accepted: boolean;
}

export type RunEvent = { line: number; e: Record<string, unknown> };

export function readEvents(file: string): RunEvent[] {
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((raw, i) => ({ raw, line: i + 1 }))
    .filter(({ raw }) => raw.trim())
    .map(({ raw, line }) => ({ line, e: JSON.parse(raw) as Record<string, unknown> }));
}

/** Pair every tool_call with the tool_result that follows it (the loop runs tools one at a time). Only events before line `before`. */
export function pairCalls(events: RunEvent[], before: number = Number.POSITIVE_INFINITY): Call[] {
  const calls: Call[] = [];
  for (let i = 0; i < events.length; i++) {
    const { line, e } = events[i]!;
    if (line >= before) break;
    if (e.type !== 'tool_call') continue;
    const result = events.slice(i + 1).find((x) => x.e.type === 'tool_result' && x.e.name === e.name);
    calls.push({
      line,
      name: String(e.name),
      input: (e.input ?? {}) as Record<string, unknown>,
      ok: result?.e.ok === true,
      preview: typeof result?.e.preview === 'string' ? result.e.preview : undefined,
      durationMs: result ? Date.parse(String(result.e.t)) - Date.parse(String(e.t)) : 0,
    });
  }
  return calls;
}

/**
 * Every recording in order: a segment opens at an accepted begin_scenario
 * and closes at the next accepted end_scenario (accepted), or is abandoned
 * when another accepted begin_scenario opens before one (not accepted). An
 * end_scenario the gate refused closes nothing; the calls after it belong
 * to the same open segment until the next begin_scenario.
 */
export function allSegmentsOf(calls: Call[]): Segment[] {
  const out: Segment[] = [];
  let open: Segment | null = null;
  for (const c of calls) {
    if (c.name === 'begin_scenario' && c.ok) {
      if (open) out.push(open);
      open = { name: String(c.input.name ?? ''), category: String(c.input.category ?? 'happy'), feature: typeof c.input.feature === 'string' ? c.input.feature : undefined, beginLine: c.line, endLine: c.line, calls: [], accepted: false };
      continue;
    }
    if (!open) continue;
    open.endLine = c.line;
    if (c.name === 'end_scenario' && c.ok) {
      open.accepted = true;
      out.push(open);
      open = null;
      continue;
    }
    open.calls.push(c);
  }
  if (open) out.push(open);
  return out;
}

/**
 * The recordings that reached the Critic: the accepted segments, the last
 * accepted recording of a name winning, as it does on ctx.scenarios.
 */
export function segmentsOf(calls: Call[]): Segment[] {
  const done = new Map<string, Segment>();
  for (const s of allSegmentsOf(calls)) if (s.accepted) done.set(s.name, s);
  return [...done.values()];
}
