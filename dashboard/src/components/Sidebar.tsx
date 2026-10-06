import { useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { LayoutGrid, List, AlertCircle, ClipboardCheck, Settings, Play, Moon, Sun, RefreshCw, Check } from 'lucide-react';
import { TermTip } from '@/components/Term';
import { useGateway } from '@/lib/gateway';
import { useTheme } from '@/lib/theme';
import { formatMoney } from '@/lib/format';
import { api } from '@/lib/api';
import type { GlossaryKey } from '@/lib/glossary';

const MODEL_LABEL: Record<string, string> = { QA_CORE_PLANNER_MODEL: 'plan', QA_CORE_EXPLORER_MODEL: 'explore', QA_CORE_CRITIC_MODEL: 'review' };
const MODEL_TERM: Record<string, GlossaryKey> = { QA_CORE_PLANNER_MODEL: 'modelPlan', QA_CORE_EXPLORER_MODEL: 'modelExplore', QA_CORE_CRITIC_MODEL: 'modelReview' };
// The mockup lists the models explore, review, plan.
const MODEL_ORDER = ['QA_CORE_EXPLORER_MODEL', 'QA_CORE_CRITIC_MODEL', 'QA_CORE_PLANNER_MODEL'];

const NAV: Array<{ to: string; label: string; icon: typeof LayoutGrid; testid: string }> = [
  { to: '/', label: 'Projects', icon: LayoutGrid, testid: 'nav-projects' },
  { to: '/runs', label: 'Runs', icon: List, testid: 'nav-runs' },
  { to: '/findings', label: 'To review', icon: AlertCircle, testid: 'nav-findings' },
  { to: '/coverage', label: 'Requirements', icon: ClipboardCheck, testid: 'nav-coverage' },
  { to: '/settings', label: 'Settings', icon: Settings, testid: 'nav-settings' },
];

/**
 * The app frame (redesign v2, docs/ui/redesign-v2/): a left sidebar with the
 * brand, the primary "Run a test" button (the Terminal route, unchanged), the
 * nav with icons, and a status box pinned at the bottom: the gateway state
 * from the socket, this session's spend (the run_report totals, as the old
 * Session chip), the model names in mono, the rebuild-index button and the
 * theme toggle. The To review badge is the server-summed totals.to_review of
 * /api/projects (product findings only, invariant 67), hidden when 0; the
 * sidebar adds nothing. Below 768px the sidebar stacks above the content.
 */
export function Sidebar({ refreshKey, onReindexed }: { refreshKey: number; onReindexed?: () => void }) {
  const gw = useGateway();
  const [theme, toggle] = useTheme();
  const [toReview, setToReview] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    api.projectsWithTotals().then((r) => { if (live) setToReview(r.totals.to_review); }).catch(() => { if (live) setToReview(null); });
    return () => { live = false; };
  }, [refreshKey]);
  const models = MODEL_ORDER.map((name) => gw.settings.find((s) => s.name === name)).filter((s): s is NonNullable<typeof s> => !!s);
  const socketTone = gw.socket === 'connected' ? 'pass' : gw.socket === 'connecting' ? 'rework' : 'reject';
  const socketWord = gw.socket === 'connected' ? 'Gateway connected' : gw.socket === 'connecting' ? 'Gateway connecting' : 'Gateway offline';
  const iconButton = 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line-strong bg-bg-1 text-fg-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
  return (
    <nav aria-label="Main" className="flex w-full flex-col gap-6 border-b border-line bg-bg-1 p-4 md:sticky md:top-0 md:h-screen md:w-[236px] md:shrink-0 md:border-b-0 md:border-r md:px-4 md:py-6" data-testid="sidebar">
      <Link to="/" className="flex items-center gap-2 rounded-md px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label="QA-Core, projects" data-testid="brand">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-brand-fg" aria-hidden="true"><Check className="h-4 w-4" strokeWidth={2.5} /></span>
        <span className="text-subheading font-semibold text-fg">QA-Core</span>
      </Link>
      {/* The one filled primary of the frame; on the Run a test page itself (which has its own Start) it reads as the active destination instead. */}
      <NavLink to="/terminal" className={({ isActive }) => `flex h-9 items-center justify-center gap-2 rounded-md px-4 text-body font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${isActive ? 'border border-brand text-brand' : 'bg-brand text-brand-fg hover:opacity-90'}`} data-testid="run-a-test">
        <Play className="h-4 w-4" aria-hidden="true" /> Run a test
      </NavLink>
      <div className="flex flex-col gap-1 text-body" data-testid="nav">
        {NAV.map(({ to, label, icon: Icon, testid }) => (
          <NavLink key={to} to={to} end={to === '/'} data-testid={testid} className={({ isActive }) => `flex items-center justify-between gap-2 rounded-md px-3 py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${isActive ? 'bg-nav-active text-nav-active-fg' : 'text-fg-2 hover:bg-bg-2 hover:text-fg'}`}>
            <span className="flex items-center gap-2"><Icon className="h-4 w-4" aria-hidden="true" />{label}</span>
            {to === '/findings' && toReview ? <span className="inline-flex h-5 items-center rounded-full bg-finding-soft px-2 text-caption font-medium text-finding" data-testid="nav-to-review-count">{toReview}</span> : null}
          </NavLink>
        ))}
      </div>
      <div className="mt-auto flex flex-col gap-1 rounded-lg bg-bg-2 px-2 py-3 text-caption text-fg-2" data-testid="status-box">
        <div className="flex items-center justify-between gap-2">
          <TermTip term="gateway">
            <span tabIndex={0} className="flex min-w-0 items-center gap-2 whitespace-nowrap rounded-sm font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="gateway-status" data-socket={gw.socket}>
              <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${socketTone === 'pass' ? 'bg-pass' : socketTone === 'rework' ? 'bg-rework' : 'bg-reject'}`} data-testid="gateway-dot" />
              {socketWord}
            </span>
          </TermTip>
          <span className="flex shrink-0 items-center gap-1">
            <TermTip term="reindex">
              <button type="button" className={iconButton} aria-label="Rebuild the index" data-testid="reindex" onClick={async () => { try { await api.reindex(); onReindexed?.(); } catch { /* shown by the page */ } }}>
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </TermTip>
            <TermTip term="theme">
              <button type="button" className={iconButton} onClick={toggle} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} data-testid="theme-toggle" data-theme={theme}>
                {theme === 'dark' ? <Sun className="h-3.5 w-3.5" aria-hidden="true" /> : <Moon className="h-3.5 w-3.5" aria-hidden="true" />}
              </button>
            </TermTip>
          </span>
        </div>
        <TermTip term="session">
          <span tabIndex={0} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="session-spend">This session <span className="money font-medium text-fg">{formatMoney(gw.sessionSpend)}</span></span>
        </TermTip>
        {models.length ? (
          <span className="mono" data-testid="model-chips" aria-label="Models by stage">
            {models.map((m, i) => (
              <span key={m.name}>
                {i ? ' · ' : ''}
                <TermTip term={MODEL_TERM[m.name] ?? 'modelPlan'}>
                  <span tabIndex={0} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="model-chip" data-stage={MODEL_LABEL[m.name]} data-from-env={m.fromEnv ? 'true' : 'false'}>{m.value.replace(/^claude-/, '')}</span>
                </TermTip>
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </nav>
  );
}
