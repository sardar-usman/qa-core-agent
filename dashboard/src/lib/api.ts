/**
 * REST client. The token lives in memory only (plan section 6.4): it comes
 * from the page hash (#token=...) or the Connect box and is never persisted.
 */
export interface ProjectCard {
  id: string; name: string; base_url: string | null; environment: string | null; srs_path: string | null;
  runs: number; shipped: number; legacy_runs: number; open_findings: number; spend_month: number; spend_total: number;
  last_run: { id: string; status: string; started_at: string | null; shipped: number | null; generated: number; cost_total: number } | null;
  coverage_series: Array<{ run_id: string; started_at: string | null; percent: number }>;
}

export interface RunRow {
  id: string; project_id: string; project_name?: string; started_at: string | null; ended_at: string | null;
  status: 'running' | 'completed' | 'stopped' | 'empty' | 'failed' | 'legacy'; source: string; url: string | null;
  planned: number; generated: number; dropped: number; incomplete: number; findings: number; skipped: number;
  stable: number; flaky: number; broken: number; shipped: number | null;
  cost_total: number; cost_planner: number; cost_explorer: number; cost_critic: number; cost_repair: number;
  flake_rate: number | null; report_path: string | null; zip_path: string | null; checkpoint_path: string | null; stopped_reason: string | null;
}

export interface RunDetailScenario {
  name: string; feature: string | null; category: string | null;
  verdict: 'pass' | 'rework' | 'reject' | null; reasons: string[]; required_fixes: string[];
  repair: 'none' | 'repaired' | 'failed'; repair_second: string | null;
  replay: 'pass' | 'fail' | null; replay_error: string | null;
  stability: { passes: number; iterations: number; pattern: string | null; classification: string | null; recovered: boolean } | null;
  shipped: boolean; dropped_at: string | null; dropped_reason: string | null; incomplete_reason: string | null; skipped_reason: string | null;
}
export interface RunDetailHeader {
  run_id: string; project_id: string; project_name: string; host: string | null; url: string | null;
  started_at: string | null; ended_at: string | null; environment: string | null; status: string; source: string;
  cost: { total: number; planner: number; explorer: number; critic: number; repair: number; stabilizer: number | null };
  stopped_reason: string | null;
}
export interface RunDetailArtifact { name: string; kind: string; size: number; href: string }
/** The server emits the first four; pending and running exist only in the live view built from events. */
export type StageStatus = 'done' | 'warning' | 'attention' | 'not-applicable' | 'pending' | 'running';
export type StageKey = 'discovery' | 'plan' | 'explore' | 'review' | 'verify' | 'summary';
/** The six-stage view payload. Every value is a report field; see src/server/run-detail.ts buildStages. */
export interface RunDetailStages {
  discovery: { status: StageStatus; stat: string; method: string | null; pages: Array<{ url: string; source: string; feature: string | null; volatile: boolean }>; warnings: string[] };
  plan: { status: StageStatus; stat: string; planner_usd: number; scenarios: Array<{ name: string; feature: string | null; category: string | null; rule_ids: string[]; page_url: string | null }>; pages: Array<{ url: string | null; count: number }> };
  explore: {
    status: StageStatus; stat: string; steps: number; scenarios_recorded: number; explorer_usd: number; repair_usd: number;
    gate_injections: Array<{ scenario: string; step_index: number; assertion_type: string; detail: string }>;
    gate_broken: Array<{ scenario: string; reason: string; attempts: number }>;
    skipped: Array<{ scenario: string; reason: string }>; incomplete: Array<{ scenario: string; reason: string }>;
    heals: Array<{ scenario: string | null; intent: string; from: string; to: string }>;
    stopped: { kind: string; reason: string } | null;
  };
  review: {
    status: StageStatus; stat: string; ran: boolean; counts: { pass: number; rework: number; reject: number }; critic_usd: number;
    verdicts: Array<{ scenario: string; verdict: 'pass' | 'rework' | 'reject'; reasons: string[]; required_fixes: string[] }>;
    journeys: Array<{ scenario: string; first: 'rework'; second: string | null; outcome: 'kept' | 'dropped' }>;
    repair: { count: number; spent_usd: number } | null; summary: string | null;
  };
  verify: {
    status: StageStatus; stat: string;
    replay: { passed: number; failed: number; duration_ms: number; verdicts: Array<{ name: string; passed: boolean; failed_step: number | null; step_kind: string | null; error: string | null }> } | null;
    stability: { iterations: number; passed: number; flaked: number; flaky: number | null; broken: number | null; recovered: number | null; flake_rate: number; stabilizer_cost_usd: number | null; verdicts: Array<{ name: string; iterations: number; passes: number; pattern: string | null; classification: string | null; recovered: boolean; gave_up: boolean }> } | null;
  };
  summary: {
    status: StageStatus; stat: string; shipped: number; total_usd: number; findings_count: number; uncovered_count: number; attention: number;
    funnel: { planned: number; generated: number; dropped: number; dropped_by_stage: Record<string, number>; incomplete: number; findings: number; skipped: number; balanced: boolean; added: number } | null;
    cost_split: { planner: number; explorer: number; critic: number; repair: number; stabilizer: number; total: number };
    rule_coverage: { covered: Array<{ rule_id: string; scenarios: string[] }>; uncovered: Array<{ rule_id: string; text: string; reason: string }> } | null;
    zip: RunDetailArtifact | null; stopped: { kind: string; reason: string } | null;
  };
}
export interface RunDetailFinding { scenario: string; category: string | null; expected: string; url: string; messages: string[]; verdict: { verdict: 'pass' | 'rework' | 'reject'; reasons: string[] } | null }
export interface StoredEvent { t: string; type: string; [k: string]: unknown }
export type RunDetail =
  | {
      legacy: false; run: RunRow; header: RunDetailHeader; scenarios: RunDetailScenario[];
      counts: { planned: number; shipped: number | null; generated: number; dropped: number; incomplete: number; findings: number; skipped: number; stable: number; flaky: number; broken: number };
      findings: RunDetailFinding[]; stages: RunDetailStages;
      review_summary: string | null; unmatched_verdicts: Array<{ scenario: string; verdict: string; reasons: string[] }>;
      artifacts: RunDetailArtifact[]; events: StoredEvent[] | null; events_status: 'present' | 'empty' | 'absent';
    }
  | {
      legacy: true; run: RunRow; header: RunDetailHeader;
      summary: { explored: number; cost_total: number; started_at: string | null; ended_at: string | null; model: string | null; duration_sec: number | null };
      artifacts: RunDetailArtifact[]; events: StoredEvent[] | null; events_status: 'present' | 'empty' | 'absent';
    };

export type ParsedCommand =
  | { ok: true; kind: 'explore'; request: Record<string, unknown>; notes: string[]; naturalHint: string | null }
  | { ok: true; kind: 'transcribe' | 'generate' | 'heal' | 'eval'; summary: string }
  | { ok: false; error: string };

let token = '';
export function setToken(t: string): void { token = t; }
export function getToken(): string { return token; }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* keep */ }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export const api = {
  projects: () => get<{ projects: ProjectCard[] }>('/api/projects').then((r) => r.projects),
  project: (id: string) => get<Record<string, unknown>>(`/api/projects/${encodeURIComponent(id)}`),
  runs: (q: { project_id?: string; status?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.project_id) p.set('project_id', q.project_id);
    if (q.status) p.set('status', q.status);
    if (q.limit) p.set('limit', String(q.limit));
    return get<{ runs: RunRow[] }>(`/api/runs${p.toString() ? '?' + p : ''}`).then((r) => r.runs);
  },
  run: (id: string) => get<{ run: RunRow }>(`/api/runs/${encodeURIComponent(id)}`).then((r) => r.run),
  runDetail: (id: string) => get<RunDetail>(`/api/runs/${encodeURIComponent(id)}/detail`),
  /** Append the in-memory token to a file link (an <a href> cannot carry a header). */
  withToken: (href: string) => (token ? `${href}${href.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : href),
  report: (id: string) => get<Record<string, unknown>>(`/api/runs/${encodeURIComponent(id)}/report`),
  zipUrl: (id: string) => `/api/runs/${encodeURIComponent(id)}/zip${token ? `?token=${encodeURIComponent(token)}` : ''}`,
  /** The Terminal page's one parser: the gateway's parseGatewayCommand over the displayed command. */
  parseCommand: async (content: string, lang: 'ts' | 'js') => {
    const res = await fetch('/api/command/parse', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ content, lang }) });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return (await res.json()) as ParsedCommand;
  },
  reindex: async () => {
    const res = await fetch('/api/reindex', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return (await res.json()) as { ok: boolean; result: Record<string, number> };
  },
};
