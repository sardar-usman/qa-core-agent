import { NavLink } from 'react-router-dom';
import { Moon, Sun, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { BrandMark } from '@/components/BrandMark';
import { TermTip } from '@/components/Term';
import { useGateway } from '@/lib/gateway';
import { useTheme } from '@/lib/theme';
import { money } from '@/lib/utils';
import { api } from '@/lib/api';
import type { GlossaryKey } from '@/lib/glossary';

const MODEL_SETTINGS = ['QA_CORE_PLANNER_MODEL', 'QA_CORE_EXPLORER_MODEL', 'QA_CORE_CRITIC_MODEL'];
const MODEL_LABEL: Record<string, string> = { QA_CORE_PLANNER_MODEL: 'plan', QA_CORE_EXPLORER_MODEL: 'explore', QA_CORE_CRITIC_MODEL: 'review' };
const MODEL_TERM: Record<string, GlossaryKey> = { QA_CORE_PLANNER_MODEL: 'modelPlan', QA_CORE_EXPLORER_MODEL: 'modelExplore', QA_CORE_CRITIC_MODEL: 'modelReview' };

const NAV: Array<[string, string]> = [['/', 'Projects'], ['/runs', 'Runs'], ['/findings', 'Findings'], ['/coverage', 'Coverage'], ['/terminal', 'Terminal'], ['/settings', 'Settings']];

/**
 * The app shell header, two rows by design: the brand mark and wordmark,
 * the nav with a clear active state and the two actions (rebuild the index,
 * theme); then a status strip with the chips grouped and labelled: the
 * gateway connection and this session's spend on the left, the model per
 * stage on the right. Every chip carries its glossary tooltip. The values
 * are the gateway's own (socket state, settings message, run_report totals);
 * nothing is computed here.
 */
export function Header({ onReindexed }: { onReindexed?: () => void }) {
  const gw = useGateway();
  const [theme, toggle] = useTheme();
  const models = gw.settings.filter((s) => MODEL_SETTINGS.includes(s.name));
  const socketTone = gw.socket === 'connected' ? 'pass' : gw.socket === 'connecting' ? 'rework' : 'reject';
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg-1/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-content items-center gap-6 px-6">
        <NavLink to="/" className="flex items-center gap-2.5 rounded-md py-1 pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label="QA-Core, projects">
          <BrandMark size={22} />
          <span className="text-m font-semibold tracking-tight text-fg">QA-Core</span>
        </NavLink>
        <nav className="flex items-center gap-0.5 text-s" aria-label="Pages">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `rounded-md px-2.5 py-1.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${isActive ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-bg-2 hover:text-fg'}`}>{label}</NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <TermTip term="reindex">
            <Button variant="ghost" size="icon" aria-label="Rebuild the index" data-testid="reindex" onClick={async () => { try { await api.reindex(); onReindexed?.(); } catch { /* shown by the page */ } }}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </TermTip>
          <TermTip term="theme">
            <Button variant="ghost" size="icon" onClick={toggle} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} data-testid="theme-toggle" data-theme={theme}>
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </TermTip>
        </div>
      </div>
      <div className="border-t border-line/60 bg-bg-0/40">
        <div className="mx-auto flex min-h-10 max-w-content flex-wrap items-center gap-x-4 gap-y-1.5 px-6 py-1.5" data-testid="header-chips">
          <TermTip term="gateway">
            <Badge tabIndex={0} variant={socketTone} data-testid="gateway-status">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${socketTone === 'pass' ? 'bg-pass' : socketTone === 'rework' ? 'bg-rework' : 'bg-reject'}`} />
              gateway {gw.socket}
            </Badge>
          </TermTip>
          <TermTip term="session">
            <Badge tabIndex={0} variant="outline" data-testid="session-spend">Session <span className="money text-cost">{money(gw.sessionSpend)}</span></Badge>
          </TermTip>
          {models.length ? (
            <div className="ml-auto flex flex-wrap items-center gap-1.5" data-testid="model-chips" aria-label="Models by stage">
              <span className="mr-1 text-xs font-medium uppercase tracking-wide text-fg-3">models</span>
              {models.map((m) => (
                <TermTip key={m.name} term={MODEL_TERM[m.name] ?? 'modelPlan'}>
                  <Badge tabIndex={0} variant="outline" data-testid="model-chip" data-from-env={m.fromEnv ? 'true' : 'false'}>
                    <span className="font-normal text-fg-3">{MODEL_LABEL[m.name]}</span> <span className="mono font-medium">{m.value.replace(/^claude-/, '')}</span>
                  </Badge>
                </TermTip>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
