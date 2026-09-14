/**
 * REST client. The token lives in memory only (plan section 6.4): it comes
 * from the page hash (#token=...) or the Connect box and is never persisted.
 */
export interface ProjectCard {
  id: string; name: string; base_url: string | null; environment: string; srs_path: string | null;
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
  report: (id: string) => get<Record<string, unknown>>(`/api/runs/${encodeURIComponent(id)}/report`),
  zipUrl: (id: string) => `/api/runs/${encodeURIComponent(id)}/zip${token ? `?token=${encodeURIComponent(token)}` : ''}`,
  reindex: async () => {
    const res = await fetch('/api/reindex', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return (await res.json()) as { ok: boolean; result: Record<string, number> };
  },
};
