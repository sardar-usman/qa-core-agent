import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { api, FINDING_STATUSES, type FindingRow, type FindingStatus } from '@/lib/api';
import { Term, TermTip, Tip } from '@/components/Term';
import type { GlossaryKey } from '@/lib/glossary';
import { fmtDate, pathOf } from '@/lib/utils';

/**
 * Findings are product behavior the agent observed that differed from what
 * a scenario expected. They are never test failures and never scenario rows:
 * violet everywhere, under "Product behavior to review". One row per deduped
 * finding (the index dedupes on project, normalized scenario, expected), with
 * every run that saw it. Status and notes are edited inline through the
 * token-guarded PATCH and kept by the index across re-indexes.
 *
 * Layout: a fixed column grid so nothing wraps into a neighbour at 1280 or
 * 1440. Long text is clamped to two lines with the full text in a tooltip;
 * the page column shows the path only (the host is the project's) with the
 * full URL in a tooltip; "Seen" is one line; Status is ONE control, a select
 * styled as the status badge; Notes is a single line that grows on focus.
 */

const STATUS_CLASS: Record<FindingStatus, string> = {
  open: 'bg-finding-soft text-finding', triaged: 'bg-accent-soft text-accent', fixed: 'bg-pass-soft text-pass', 'wont-fix': 'bg-neutral-soft text-neutral',
};
const STATUS_TERM: Record<FindingStatus, GlossaryKey> = { open: 'findingStatusOpen', triaged: 'findingStatusTriaged', fixed: 'findingStatusFixed', 'wont-fix': 'findingStatusWontFix' };

export function FindingsHeading({ count }: { count: number }) {
  return (
    <div>
      <h2 className="text-section font-semibold text-finding" data-testid="findings-heading">Product behavior to review <span className="tabular-nums text-s font-normal">{count}</span></h2>
      <p className="mt-1 text-s text-fg-2">A finding is product behavior the agent observed that differed from what the scenario expected. It is not a test failure and never counts as one.</p>
    </div>
  );
}

export function FindingsTable({ findings, showProject = true, onChange }: { findings: FindingRow[]; showProject?: boolean; onChange?: (f: FindingRow) => void }) {
  if (findings.length === 0) return <div className="rounded-lg border border-finding/40 bg-finding-soft px-4 py-3 text-s text-fg-2" data-testid="no-findings">No findings recorded</div>;
  return (
    <div className="rounded-lg border border-finding/40 bg-finding-soft p-2">
      <div className="overflow-hidden rounded-md border border-line bg-bg-1">
        <table className="w-full table-fixed text-m" data-testid="findings-table">
          <colgroup>
            {showProject ? <col className="w-[11%]" /> : null}
            <col className={showProject ? 'w-[27%]' : 'w-[32%]'} />
            <col className={showProject ? 'w-[18%]' : 'w-[20%]'} />
            <col className="w-[14%]" />
            <col className="w-[12%]" />
            <col className="w-[9%]" />
            <col className={showProject ? 'w-[9%]' : 'w-[13%]'} />
          </colgroup>
          <thead className="bg-bg-2 text-left text-xs font-semibold uppercase tracking-wide text-fg-2">
            <tr>
              {showProject ? <th className="h-10 px-3">Project</th> : null}
              <th className="h-10 px-3">Scenario</th>
              <th className="h-10 px-3"><Term term="findingExpected">Expected</Term></th>
              <th className="h-10 px-3"><Term term="findingPage">Page</Term></th>
              <th className="h-10 px-3"><Term term="findingSeen">Seen</Term></th>
              <th className="h-10 px-3"><Term term="findingStatus">Status</Term></th>
              <th className="h-10 px-3"><Term term="findingNotes">Notes</Term></th>
            </tr>
          </thead>
          <tbody>
            {findings.map((f) => <FindingRowView key={f.id} f={f} showProject={showProject} onChange={onChange} />)}
          </tbody>
        </table>
      </div>
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
  const first = f.first_seen_at ? fmtDate(f.first_seen_at) : f.first_seen_run_id;
  const last = f.last_seen_at ? fmtDate(f.last_seen_at) : f.last_seen_run_id;
  const sameDay = first === last;
  const seenTip = sameDay ? `seen ${f.times_seen} time${f.times_seen === 1 ? '' : 's'}, ${f.first_seen_at ?? f.first_seen_run_id}` : `first ${f.first_seen_at ?? f.first_seen_run_id}, last ${f.last_seen_at ?? f.last_seen_run_id}`;
  return (
    <tr className="border-t border-line align-top" data-testid="finding-row" data-finding-id={f.id} data-status={f.status}>
      {showProject ? <td className="px-3 py-3"><Link to={`/projects/${encodeURIComponent(f.project_id)}`} className="truncate text-fg hover:underline">{f.project_name}</Link></td> : null}
      <td className="px-3 py-3">
        <div className="font-semibold text-finding" data-testid="finding-scenario">{f.scenario}</div>
        {f.observed ? <Tip text={f.observed} className="block"><div className="line-clamp-2 text-s text-fg-3" data-testid="finding-observed">{f.observed}</div></Tip> : null}
      </td>
      <td className="px-3 py-3"><Tip text={f.expected} className="block"><div className="line-clamp-2 text-s text-fg-2" data-testid="finding-expected">{f.expected}</div></Tip></td>
      <td className="px-3 py-3">{f.page_url ? <Tip text={f.page_url} className="block min-w-0"><div className="truncate text-s text-fg-2" data-testid="finding-url">{pathOf(f.page_url)}</div></Tip> : <span className="text-s text-fg-3" data-testid="finding-url">no URL recorded</span>}</td>
      <td className="whitespace-nowrap px-3 py-3 text-s text-fg-2">
        <Tip text={seenTip} className="inline-block">
          <span className="tabular-nums text-fg" data-testid="finding-times-seen">{f.times_seen}</span> time{f.times_seen === 1 ? '' : 's'}, {sameDay ? '' : 'last '}<Link className="text-fg-2 hover:underline" to={`/runs/${encodeURIComponent(f.last_seen_run_id)}`} data-testid="finding-last-run" onClick={(e) => e.stopPropagation()}>{last}</Link>
        </Tip>
      </td>
      <td className="px-3 py-3">
        <span className="relative inline-flex items-center">
          <TermTip term={STATUS_TERM[f.status]}>
            <select className={`h-7 cursor-pointer appearance-none rounded-full border border-transparent py-0 pl-2.5 pr-6 text-s font-semibold leading-5 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 ${STATUS_CLASS[f.status]}`} value={f.status} disabled={saving} onChange={(e) => save({ status: e.target.value as FindingStatus })} data-testid="finding-status" aria-label="Finding status">
              {FINDING_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </TermTip>
          <ChevronDown className="pointer-events-none absolute right-1.5 h-3 w-3 opacity-70" aria-hidden="true" />
        </span>
      </td>
      <td className="px-3 py-3">
        <textarea rows={1} className="block h-8 w-full resize-none rounded-md border border-line-strong bg-bg-2 px-2 py-1.5 text-s leading-5 text-fg transition-[height] placeholder:text-fg-3 focus:h-24 focus:outline-none focus:ring-2 focus:ring-accent" placeholder="notes" value={notes} disabled={saving} onChange={(e) => setNotes(e.target.value)} onBlur={() => { if ((notes || '') !== (f.notes ?? '')) void save({ notes: notes || null }); }} data-testid="finding-notes" aria-label="Finding notes" />
        {error ? <div className="mt-1 text-s text-reject" data-testid="finding-error">{error}</div> : null}
      </td>
    </tr>
  );
}
