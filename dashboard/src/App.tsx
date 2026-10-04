import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Header } from '@/components/Header';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ProjectsPage } from '@/pages/Projects';
import { RunsPage } from '@/pages/Runs';
import { RunDetailPage } from '@/pages/RunDetail';
import { TerminalPage } from '@/pages/Terminal';
import { ProjectPage } from '@/pages/Project';
import { FindingsPage } from '@/pages/Findings';
import { CoveragePage } from '@/pages/Coverage';
import { SettingsPage } from '@/pages/Settings';
import { connectGateway, useGateway } from '@/lib/gateway';

export default function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const gw = useGateway();
  useEffect(() => { connectGateway(); }, []);
  // A finished run or a runs sync from the gateway refreshes the lists.
  useEffect(() => { setRefreshKey((k) => k + 1); }, [gw.runsChanged]);
  return (
    <BrowserRouter>
      <TooltipProvider delayDuration={300} skipDelayDuration={200}>
        <div className="min-h-full">
          <Header onReindexed={() => setRefreshKey((k) => k + 1)} />
          <main className="mx-auto max-w-content px-6 py-8">
            <PageTransition>
              <Routes>
                <Route path="/" element={<ProjectsPage refreshKey={refreshKey} />} />
                <Route path="/projects/:id" element={<ProjectPage refreshKey={refreshKey} />} />
                <Route path="/findings" element={<FindingsPage refreshKey={refreshKey} />} />
                <Route path="/coverage" element={<CoveragePage refreshKey={refreshKey} />} />
                <Route path="/runs" element={<RunsPage refreshKey={refreshKey} />} />
                <Route path="/runs/:id" element={<RunDetailPage />} />
                <Route path="/terminal" element={<TerminalPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<ProjectsPage refreshKey={refreshKey} />} />
              </Routes>
            </PageTransition>
          </main>
        </div>
      </TooltipProvider>
    </BrowserRouter>
  );
}

/** Page content fades in (150 ms) on every route change; off under prefers-reduced-motion (index.css). */
function PageTransition({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <div key={pathname} className="page-enter">{children}</div>;
}
