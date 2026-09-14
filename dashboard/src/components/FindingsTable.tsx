import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, FINDING_STATUSES, type FindingRow, type FindingStatus } from '@/lib/api';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { fmtDate } from '@/lib/utils';

/**
 * Findings are product behavior the agent observed that differed from what
 * a scenario expected. They are never test failures and never scenario rows:
 * violet everywhere, under "Product behavior to review". One row per deduped
 * finding (the index dedupes on project, normalized scenario, expected), with
 * every run that saw it. Status and notes are edited inline through the
 * token-guarded PATCH and kept by the index across re-indexes.
 */

const STATUS_VARIANT: Record<FindingStatus, 'finding' | 'accent' | 'pass' | 'neutral'> = { open: 'finding', triaged: 'accent', fixed: 'pass', 'wont-fix': 'neutral' };

export function FindingsHeading({ count }: { count: number }) {
  return (
    <div>
      <h2 className="text-m font-semibold text-finding" data-testid="findings-heading">Product behavior to review <span className="mono text-s font-normal">{count}</span></h2>
      <p className="mt-1 text-s text-fg-2">A finding is product behavior the agent observed that differed from what the scenario expected. It is not a test failure and never counts as one.</p>
    </div>
  );
}

export function FindingsTable({ findings, showProject = true, onChange }: { findings: FindingRow[]; showProject?: boolean; onChange?: (f: FindingRow) => void }) {
  if (findings.length === 0) return <div className="rounded-lg border border-finding/40 bg-finding-soft px-4 py-3 text-s text-fg-2" data-testid="no-findings">No findings recorded</div>;
  return (
    <div className="rounded-lg border border-finding/40 bg-finding-soft p-2">
      <Table data-testid="findings-table">
        <TableHeader>
          <TableRow>
            {showProject ? <TableHead>Project</TableHead> : null}
            <TableHead>Scenario</TableHead>
            <TableHead>Expected</TableHead>
            <TableHead>URL at the time</TableHead>
            <TableHead>Seen</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Notes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {findings.map((f) => <FindingRowView key={f.id} f={f} showProject={showProject} onChange={onChange} />)}
        </TableBody>
      </Table>
    </div>
  );
}

function FindingRowView({ f, showProject, onChange }: { f: FindingRow; showProject: boolean; onChange?: (f: FindingRow) => void }) {
  const [notes, setNotes] = useState(f.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (body: { status?: FindingStatus; notes?: string | null }) => {
    setSaving(true); setError(null);
    try { const updated = await api.patchFinding(f.id, body); onChange?.(updated); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <TableRow data-testid="finding-row" data-finding-id={f.id} data-status={f.status}>
      {showProject ? <TableCell><Link to={`/projects/${encodeURIComponent(f.project_id)}`} className="text-fg hover:underline">{f.project_name}</Link></TableCell> : null}
      <TableCell><div className="font-semibold text-finding" data-testid="finding-scenario">{f.scenario}</div>{f.observed ? <div className="text-s text-fg-3">{f.observed}</div> : null}</TableCell>
      <TableCell className="max-w-xs text-s text-fg-2" data-testid="finding-expected">{f.expected}</TableCell>
      <TableCell className="max-w-xs"><span className="mono truncate text-s text-fg-2" title={f.page_url ?? ''} data-testid="finding-url">{f.page_url ?? 'n/a'}</span></TableCell>
      <TableCell className="text-s text-fg-2">
        <div><span className="mono text-fg" data-testid="finding-times-seen">{f.times_seen}</span> time{f.times_seen === 1 ? '' : 's'}</div>
        <div>first <Link className="mono hover:underline" to={`/runs/${encodeURIComponent(f.first_seen_run_id)}`} data-testid="finding-first-run" title={f.first_seen_at ?? ''}>{f.first_seen_at ? fmtDate(f.first_seen_at) : f.first_seen_run_id}</Link></div>
        <div>last <Link className="mono hover:underline" to={`/runs/${encodeURIComponent(f.last_seen_run_id)}`} data-testid="finding-last-run" title={f.last_seen_at ?? ''}>{f.last_seen_at ? fmtDate(f.last_seen_at) : f.last_seen_run_id}</Link></div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-1">
          <Badge variant={STATUS_VARIANT[f.status]} data-testid="finding-status-badge">{f.status}</Badge>
          <select className="h-7 rounded-md border border-line-strong bg-bg-2 px-1 text-s text-fg" value={f.status} disabled={saving} onChange={(e) => save({ status: e.target.value as FindingStatus })} data-testid="finding-status" aria-label="Finding status">
            {FINDING_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </TableCell>
      <TableCell className="min-w-[180px]">
        <textarea className="min-h-[36px] w-full rounded-md border border-line-strong bg-bg-2 px-2 py-1 text-s text-fg placeholder:text-fg-3" placeholder="notes" value={notes} disabled={saving} onChange={(e) => setNotes(e.target.value)} onBlur={() => { if ((notes || '') !== (f.notes ?? '')) void save({ notes: notes || null }); }} data-testid="finding-notes" aria-label="Finding notes" />
        {error ? <div className="text-s text-reject" data-testid="finding-error">{error}</div> : null}
      </TableCell>
    </TableRow>
  );
}
