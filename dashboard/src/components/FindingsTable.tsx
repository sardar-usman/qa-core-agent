import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { api, FINDING_STATUSES, type FindingRow, type FindingStatus } from '@/lib/api';
import { Term, TermTip, Tip } from '@/components/Term';
import type { GlossaryKey } from '@/lib/glossary';
import { pathOf } from '@/lib/utils';
import { formatCount, formatDate, formatDateTime } from '@/lib/format';
import { elementLookedFor } from '@/lib/finding-kind';

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

/**
 * Elements the agent could not find: locator findings (kind locator,
 * invariant 67). A limit of the run, never product behavior, so the section
 * is neutral grey (never violet, never the reject colour), collapsed by
 * default, read only (no status control), and its count is not in To review.
 * Columns: scenario, the element looked for (expected without the engine
 * prefix), the page path, seen.
 */
export function LocatorFailuresSection({ findings, showProject = true, open = false }: { findings: FindingRow[]; showProject?: boolean; open?: boolean }) {
  return (
    <details className="rounded-lg border border-line bg-bg-1 text-fg-2" data-testid="locator-failures" open={open}>
      <summary className="cursor-pointer px-4 py-3 text-heading font-semibold text-neutral" data-testid="locator-failures-heading">
        <Term term="locatorFailures">Elements the agent could not find</Term> <span className="tabular-nums text-small font-normal" data-testid="locator-failures-count">{findings.length}</span>
      </summary>
      <div className="flex flex-col gap-2 px-4 pb-4">
        <p className="text-small text-fg-2">The agent could not locate these elements after retrying. This is a limit of the run, not product behavior, and it is not counted in To review.</p>
        {findings.length === 0 ? <div className="text-small text-fg-2" data-testid="no-locator-failures">None recorded</div> : (
          <div className="overflow-hidden rounded-md border border-line bg-bg-1">
            <table className="w-full table-fixed text-body" data-testid="locator-failures-table">
              <colgroup>
                {showProject ? <col className="w-[14%]" /> : null}
                <col className={showProject ? 'w-[36%]' : 'w-[42%]'} />
                <col className="w-[22%]" />
                <col className="w-[16%]" />
                <col className={showProject ? 'w-[12%]' : 'w-[20%]'} />
              </colgroup>
              <thead className="bg-bg-2 text-left text-caption font-medium text-fg-3">
                <tr>
                  {showProject ? <th className="h-9 px-3 font-medium">Project</th> : null}
                  <th className="h-9 px-3 font-medium">Scenario</th>
                  <th className="h-9 px-3 font-medium">Element looked for</th>
                  <th className="h-9 px-3 font-medium"><Term term="findingPage">Page</Term></th>
                  <th className="h-9 px-3 font-medium"><Term term="findingSeen">Seen</Term></th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f) => {
                  const last = f.last_seen_at ? formatDate(f.last_seen_at) : f.last_seen_run_id;
                  return (
                    <tr key={f.id} className="border-t border-line align-top" data-testid="locator-failure-row" data-finding-id={f.id}>
                      {showProject ? <td className="px-3 py-3"><Link to={`/projects/${encodeURIComponent(f.project_id)}`} className="block truncate text-fg hover:underline" title={f.project_name}>{f.project_name}</Link></td> : null}
                      <td className="px-3 py-3">
                        <div className="font-medium text-fg" data-testid="locator-failure-scenario">{f.scenario}</div>
                        {f.observed ? <Tip text={f.observed} className="block"><div className="line-clamp-2 text-small text-fg-2">{f.observed}</div></Tip> : null}
                      </td>
                      <td className="px-3 py-3"><Tip text={f.expected} className="block"><div className="line-clamp-2 text-small text-fg-2" data-testid="locator-failure-element">{elementLookedFor(f.expected)}</div></Tip></td>
                      <td className="px-3 py-3">{f.page_url ? <Tip text={f.page_url} className="block min-w-0"><div className="truncate text-small text-fg-2" data-testid="locator-failure-url">{pathOf(f.page_url)}</div></Tip> : <span className="text-small text-fg-2" data-testid="locator-failure-url">no URL recorded</span>}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-small text-fg-2"><span className="tabular-nums text-fg">{formatCount(f.times_seen, 'time', 'times')}</span>, <Link className="text-fg-2 hover:underline" to={`/runs/${encodeURIComponent(f.last_seen_run_id)}`}>{last}</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}

export function FindingsHeading({ count }: { count: number }) {
  return (
    <div>
      <h2 className="text-heading font-semibold text-finding" data-testid="findings-heading">Product behavior to review <span className="tabular-nums text-small font-normal">{count}</span></h2>
      <p className="mt-1 text-small text-fg-2">A finding is product behavior the agent observed that differed from what the scenario expected. It is not a test failure and never counts as one.</p>
    </div>
  );
}

export function FindingsTable({ findings, showProject = true, onChange }: { findings: FindingRow[]; showProject?: boolean; onChange?: (f: FindingRow) => void }) {
  if (findings.length === 0) return <div className="rounded-lg border border-finding/40 bg-finding-soft px-4 py-3 text-small text-fg-2" data-testid="no-findings">No findings recorded</div>;
  return (
    <div className="rounded-lg border border-finding/40 bg-finding-soft p-2">
      <div className="overflow-hidden rounded-md border border-line bg-bg-1">
        <table className="w-full table-fixed text-body" data-testid="findings-table">
          <colgroup>
            {showProject ? <col className="w-[11%]" /> : null}
            <col className={showProject ? 'w-[27%]' : 'w-[32%]'} />
            <col className={showProject ? 'w-[18%]' : 'w-[20%]'} />
            <col className="w-[14%]" />
            <col className="w-[12%]" />
            <col className="w-[9%]" />
            <col className={showProject ? 'w-[9%]' : 'w-[13%]'} />
          </colgroup>
          <thead className="bg-bg-2 text-left text-caption font-medium text-fg-3">
            <tr>
              {showProject ? <th className="h-9 px-3 font-medium">Project</th> : null}
              <th className="h-9 px-3 font-medium">Scenario</th>
              <th className="h-9 px-3 font-medium"><Term term="findingExpected">Expected</Term></th>
              <th className="h-9 px-3 font-medium"><Term term="findingPage">Page</Term></th>
              <th className="h-9 px-3 font-medium"><Term term="findingSeen">Seen</Term></th>
              <th className="h-9 px-3 font-medium"><Term term="findingStatus">Status</Term></th>
              <th className="h-9 px-3 font-medium"><Term term="findingNotes">Notes</Term></th>
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
  const first = f.first_seen_at ? formatDate(f.first_seen_at) : f.first_seen_run_id;
  const last = f.last_seen_at ? formatDate(f.last_seen_at) : f.last_seen_run_id;
  const sameDay = first === last;
  const seenTip = sameDay ? `seen ${formatCount(f.times_seen, 'time', 'times')}, ${f.first_seen_at ? formatDateTime(f.first_seen_at) : f.first_seen_run_id}` : `first ${f.first_seen_at ? formatDateTime(f.first_seen_at) : f.first_seen_run_id}, last ${f.last_seen_at ? formatDateTime(f.last_seen_at) : f.last_seen_run_id}`;
  return (
    <tr className="border-t border-line align-top" data-testid="finding-row" data-finding-id={f.id} data-status={f.status}>
      {showProject ? <td className="px-3 py-3"><Link to={`/projects/${encodeURIComponent(f.project_id)}`} className="block truncate text-fg hover:underline" title={f.project_name}>{f.project_name}</Link></td> : null}
      <td className="px-3 py-3">
        <div className="font-medium text-finding" data-testid="finding-scenario">{f.scenario}</div>
        {f.observed ? <Tip text={f.observed} className="block"><div className="line-clamp-2 text-small text-fg-2" data-testid="finding-observed">{f.observed}</div></Tip> : null}
      </td>
      <td className="px-3 py-3"><Tip text={f.expected} className="block"><div className="line-clamp-2 text-small text-fg-2" data-testid="finding-expected">{f.expected}</div></Tip></td>
      <td className="px-3 py-3">{f.page_url ? <Tip text={f.page_url} className="block min-w-0"><div className="truncate text-small text-fg-2" data-testid="finding-url">{pathOf(f.page_url)}</div></Tip> : <span className="text-small text-fg-2" data-testid="finding-url">no URL recorded</span>}</td>
      <td className="whitespace-nowrap px-3 py-3 text-small text-fg-2">
        <Tip text={seenTip} className="inline-block">
          <span className="tabular-nums text-fg" data-testid="finding-times-seen">{f.times_seen}</span> {f.times_seen === 1 ? 'time' : 'times'}, {sameDay ? '' : 'last '}<Link className="text-fg-2 hover:underline" to={`/runs/${encodeURIComponent(f.last_seen_run_id)}`} data-testid="finding-last-run" onClick={(e) => e.stopPropagation()}>{last}</Link>
        </Tip>
      </td>
      <td className="px-3 py-3">
        <span className="relative inline-flex items-center">
          <TermTip term={STATUS_TERM[f.status]}>
            <select className={`h-5 cursor-pointer appearance-none rounded-full border border-transparent py-0 pl-2 pr-6 text-caption font-medium focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 ${STATUS_CLASS[f.status]}`} value={f.status} disabled={saving} onChange={(e) => save({ status: e.target.value as FindingStatus })} data-testid="finding-status" aria-label="Finding status">
              {FINDING_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </TermTip>
          <ChevronDown className="pointer-events-none absolute right-1 h-3 w-3 opacity-70" aria-hidden="true" />
        </span>
      </td>
      <td className="px-3 py-3">
        <textarea rows={1} className="block h-9 w-full resize-none rounded-md border border-line-strong bg-bg-2 px-2 py-2 text-body text-fg transition-[height] placeholder:text-fg-3 focus:h-24 focus:outline-none focus:ring-2 focus:ring-accent" placeholder="notes" value={notes} disabled={saving} onChange={(e) => setNotes(e.target.value)} onBlur={() => { if ((notes || '') !== (f.notes ?? '')) void save({ notes: notes || null }); }} data-testid="finding-notes" aria-label="Finding notes" />
        {error ? <div className="mt-1 text-small text-reject" data-testid="finding-error">{error}</div> : null}
      </td>
    </tr>
  );
}
