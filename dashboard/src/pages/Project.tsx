import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { api, ApiError, PROJECT_ENVIRONMENTS, type FindingRow, type ProjectCoverage, type ProjectDetail, type ProjectSrsState, type ProjectTrends, type RunRow } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { validateSrsFile } from '@/lib/command';
import { useRef } from 'react';
import { fmtDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { RunsTable } from '@/components/RunsTable';
import { FindingsHeading, FindingsTable } from '@/components/FindingsTable';
import { CoverageTable } from '@/components/CoverageTable';
import { Trends } from '@/components/Trends';
import { usd } from '@/lib/utils';

const ENV_VARIANT: Record<string, 'accent' | 'rework' | 'neutral'> = { staging: 'accent', production: 'rework', other: 'neutral' };

/**
 * One project: header, its runs, its findings, rule coverage across its
 * SRS runs, and trends over its completed runs. Every number is an index row
 * column or a rule-coverage row the index copied from a run folder.
 */
export function ProjectPage({ refreshKey }: { refreshKey: number }) {
  const { id = '' } = useParams();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [findings, setFindings] = useState<FindingRow[] | null>(null);
  const [coverage, setCoverage] = useState<ProjectCoverage | null>(null);
  const [trends, setTrends] = useState<ProjectTrends | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    Promise.all([api.project(id), api.runs({ project_id: id, limit: 200 }), api.findings({ project_id: id }), api.projectCoverage(id), api.projectTrends(id)])
      .then(([d, r, f, c, t]) => { if (live) { setDetail(d); setRuns(r); setFindings(f); setCoverage(c); setTrends(t); } })
      .catch((e: unknown) => { if (live) setError({ status: e instanceof ApiError ? e.status : 0, message: (e as Error).message }); });
    return () => { live = false; };
  }, [id, refreshKey, reload]);

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <Link to="/" className="inline-flex items-center gap-1 text-s text-fg-2 hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" /> Back to projects</Link>
        <EmptyState title={error.status === 404 ? 'Project not found' : error.status === 401 ? 'Unauthorized' : 'Could not load this project'}><span className="mono" data-testid="project-error">{error.message}</span></EmptyState>
      </div>
    );
  }
  if (!detail || !runs || !findings || !coverage || !trends) return <div className="text-s text-fg-2">Loading…</div>;
  const p = detail.project;
  const s = detail.summary;
  return (
    <div className="flex flex-col gap-6" data-testid="project-page" data-project-id={p.id}>
      <Link to="/" className="inline-flex items-center gap-1 text-s text-fg-2 hover:text-fg" data-testid="back-link"><ArrowLeft className="h-3.5 w-3.5" /> Back to projects</Link>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-m font-semibold" data-testid="project-name">{p.name}</h1>
          {p.environment && p.environment !== 'other' ? <Badge variant={ENV_VARIANT[p.environment] ?? 'neutral'} data-testid="env-badge">{p.environment}</Badge> : null}
          {p.base_url ? <a href={p.base_url} target="_blank" rel="noreferrer" className="mono inline-flex items-center gap-1 text-s text-accent hover:underline" data-testid="project-url">{p.base_url} <ExternalLink className="h-3 w-3" /></a> : <span className="text-s text-fg-3">no base URL</span>}
          {p.id !== 'unassigned' ? <EditProject id={p.id} name={p.name} environment={p.environment} onSaved={() => setReload((n) => n + 1)} /> : null}
        </div>
        <dl className="grid gap-3 sm:grid-cols-4">
          <Fact label="tests shipped" value={s.shipped === null ? 'n/a' : String(s.shipped)} testid="project-shipped" sub={s.legacy_runs ? `${s.legacy_runs} pre-v2 run${s.legacy_runs === 1 ? '' : 's'}, ${s.legacy_explored} scenario${s.legacy_explored === 1 ? '' : 's'} explored` : undefined} />
          <Fact label="unresolved findings" value={s.unresolved_findings === null ? 'n/a' : String(s.unresolved_findings)} tone={s.unresolved_findings ? 'finding' : undefined} testid="project-unresolved-findings" />
          <Fact label="spend this month" value={usd(s.spend_month)} tone="cost" mono testid="project-spend-month" />
          <Fact label="runs" value={String(s.runs)} testid="project-runs" sub={`${s.reported_runs} with a report`} />
        </dl>
      </header>

      <section className="flex flex-col gap-2" data-testid="project-runs">
        <h2 className="text-m font-semibold">Runs <span className="text-s font-normal text-fg-3">{runs.length}</span></h2>
        {runs.length === 0 ? <EmptyState title="No runs yet" /> : <RunsTable runs={runs} hideProject />}
      </section>

      <section className="flex flex-col gap-2" data-testid="project-findings">
        <FindingsHeading count={findings.length} />
        <FindingsTable findings={findings} showProject={false} onChange={(u) => {
          setFindings((cur) => (cur ?? []).map((f) => (f.id === u.id ? u : f)));
          // The header's unresolved-findings count is an index number; re-read it rather than adjusting it here.
          api.project(id).then((d) => setDetail(d)).catch(() => { /* the next load shows it */ });
        }} />
      </section>

      {p.id !== 'unassigned' ? <RequirementsDocument id={p.id} srs={detail.srs} onChanged={() => setReload((n) => n + 1)} /> : null}

      <section className="flex flex-col gap-2" data-testid="project-coverage">
        <h2 className="text-m font-semibold">Requirements coverage</h2>
        <CoverageTable coverage={coverage} />
      </section>

      <section className="flex flex-col gap-2" data-testid="project-trends">
        <h2 className="text-m font-semibold">Trends</h2>
        <Trends trends={trends} />
      </section>
    </div>
  );
}

/** Edit name and environment inline. The base URL is the project's identity and stays read-only. */
function EditProject({ id, name, environment, onSaved }: { id: string; name: string; environment: string | null; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(name);
  const [env, setEnv] = useState(environment ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setN(name); setEnv(environment ?? ''); }, [name, environment]);
  if (!open) return <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="edit-project">Edit</Button>;
  return (
    <form className="flex flex-wrap items-end gap-2" data-testid="edit-project-form" onSubmit={async (e) => {
      e.preventDefault(); setSaving(true); setError(null);
      try { await api.patchProject(id, { name: n.trim(), environment: env || null }); setOpen(false); onSaved(); }
      catch (err) { setError((err as Error).message); } finally { setSaving(false); }
    }}>
      <label className="flex flex-col text-s text-fg-2">name<input className={editInput} value={n} onChange={(e) => setN(e.target.value)} data-testid="edit-project-name" /></label>
      <label className="flex flex-col text-s text-fg-2">environment
        <select className={editInput} value={env} onChange={(e) => setEnv(e.target.value)} data-testid="edit-project-env">
          <option value="">unset</option>
          {PROJECT_ENVIRONMENTS.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </label>
      <span className="text-s text-fg-3" title="The base URL is the project identity and cannot be edited">base URL is read-only</span>
      <Button type="submit" size="sm" disabled={saving || !n.trim()} data-testid="edit-project-save">Save</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      {error ? <span className="text-s text-reject" data-testid="edit-project-error">{error}</span> : null}
    </form>
  );
}

const editInput = 'h-8 rounded-md border border-line-strong bg-bg-2 px-2 text-s text-fg';

/**
 * The project-level requirements document: one current SRS under
 * output/<slug>/srs/, previous uploads kept renamed with their upload time.
 * Same four types and 2 MB cap as the Terminal attach.
 */
function RequirementsDocument({ id, srs, onChanged }: { id: string; srs: ProjectSrsState; onChanged: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    const err = validateSrsFile(file.name, file.size);
    if (err) { setError(err); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const url = String(reader.result ?? '');
      setBusy(true);
      try { await api.uploadProjectSrs(id, { name: file.name, base64: url.slice(url.indexOf(',') + 1) }); onChanged(); }
      catch (e) { setError((e as Error).message); }
      finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
    };
    reader.readAsDataURL(file);
  };
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line bg-bg-1 p-4" data-testid="project-srs">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-m font-semibold">Requirements document</h2>
        <span className="text-s text-fg-2">.md, .txt, .pdf or .docx, 2 MB cap. The Terminal offers it by default for runs against this host; each run keeps its own copy.</span>
        <input ref={fileRef} type="file" accept=".md,.txt,.pdf,.docx" hidden data-testid="project-srs-file" onChange={(e) => pick(e.target.files?.[0])} />
        <Button type="button" variant="outline" size="sm" className="ml-auto" disabled={busy} onClick={() => fileRef.current?.click()} data-testid="project-srs-upload">{srs.current ? 'Replace SRS' : 'Upload SRS'}</Button>
      </div>
      {error ? <div className="text-s text-reject" data-testid="project-srs-error">{error}</div> : null}
      {srs.current ? (
        <div className="text-s" data-testid="project-srs-current"><span className="mono text-fg">{srs.current.original_name}</span> <span className="text-fg-2">uploaded {fmtDate(srs.current.uploaded_at)} · {(srs.current.size / 1024).toFixed(1)} KB · stored at <span className="mono">{srs.current.path}</span></span></div>
      ) : <div className="text-s text-fg-2" data-testid="project-srs-none">No requirements document yet.</div>}
      {srs.previous.length ? (
        <details className="text-s">
          <summary className="cursor-pointer text-fg-2">Previous uploads <span className="mono">{srs.previous.length}</span>, kept so no SRS a run used is ever lost</summary>
          <ul className="mt-1 flex flex-col gap-1" data-testid="project-srs-previous">
            {srs.previous.map((r) => <li key={r.path} className="text-fg-2" data-testid="project-srs-previous-row"><span className="mono text-fg">{r.file}</span> uploaded {fmtDate(r.uploaded_at)} <span className="mono">{r.path}</span></li>)}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function Fact({ label, value, sub, tone, mono, testid }: { label: string; value: string; sub?: string; tone?: 'finding' | 'cost'; mono?: boolean; testid: string }) {
  return (
    <div className="rounded-lg border border-line bg-bg-1 p-3">
      <dd className={`text-l font-semibold leading-none ${tone === 'finding' ? 'text-finding' : tone === 'cost' ? 'text-cost' : ''} ${mono ? 'mono' : ''}`} data-testid={testid}>{value}</dd>
      <dt className="mt-1 text-s text-fg-2">{label}</dt>
      {sub ? <div className="mt-1 text-s text-fg-3" data-testid={`${testid}-sub`}>{sub}</div> : null}
    </div>
  );
}
