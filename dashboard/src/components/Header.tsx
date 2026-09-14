import { NavLink } from 'react-router-dom';
import { Moon, Sun, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useGateway } from '@/lib/gateway';
import { useTheme } from '@/lib/theme';
import { money } from '@/lib/utils';
import { api } from '@/lib/api';

const MODEL_SETTINGS = ['QA_CORE_PLANNER_MODEL', 'QA_CORE_EXPLORER_MODEL', 'QA_CORE_CRITIC_MODEL'];
const MODEL_LABEL: Record<string, string> = { QA_CORE_PLANNER_MODEL: 'plan', QA_CORE_EXPLORER_MODEL: 'explore', QA_CORE_CRITIC_MODEL: 'review' };

export function Header({ onReindexed }: { onReindexed?: () => void }) {
  const gw = useGateway();
  const [theme, toggle] = useTheme();
  const models = gw.settings.filter((s) => MODEL_SETTINGS.includes(s.name));
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-bg-1/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 py-3">
        <NavLink to="/" className="text-m font-semibold tracking-tight">QA-Core</NavLink>
        <nav className="flex items-center gap-1 text-s">
          {[['/', 'Projects'], ['/runs', 'Runs'], ['/terminal', 'Terminal']].map(([to, label]) => (
            <NavLink key={to} to={to!} end={to === '/'} className={({ isActive }) => `rounded-md px-2.5 py-1.5 ${isActive ? 'bg-bg-3 text-fg' : 'text-fg-2 hover:text-fg'}`}>{label}</NavLink>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Badge variant={gw.socket === 'connected' ? 'pass' : gw.socket === 'connecting' ? 'rework' : 'reject'} data-testid="gateway-status">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${gw.socket === 'connected' ? 'bg-pass' : gw.socket === 'connecting' ? 'bg-rework' : 'bg-reject'}`} />
            gateway {gw.socket}
          </Badge>
          <Badge variant="outline" data-testid="session-spend">Session <span className="money text-cost">{money(gw.sessionSpend)}</span></Badge>
          {models.map((m) => (
            <Badge key={m.name} variant="outline" title={`${m.name}=${m.value}${m.fromEnv ? ' (from env)' : ' (default)'}`} data-testid="model-chip">
              <span className="text-fg-3">{MODEL_LABEL[m.name]}</span> <span className="mono">{m.value.replace(/^claude-/, '')}</span>
            </Badge>
          ))}
          <Button variant="ghost" size="icon" title="Rebuild the index from output/" aria-label="Reindex" onClick={async () => { try { await api.reindex(); onReindexed?.(); } catch { /* shown by the page */ } }}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={toggle} title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'} aria-label="Toggle theme">
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </header>
  );
}
