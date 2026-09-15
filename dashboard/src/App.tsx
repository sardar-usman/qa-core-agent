import { useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Header } from '@/components/Header';
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
      <div className="min-h-full">
        <Header onReindexed={() => setRefreshKey((k) => k + 1)} />
        <main className="mx-auto max-w-6xl px-5 py-6">
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
        </main>
      </div>
    </BrowserRouter>
  );
}
