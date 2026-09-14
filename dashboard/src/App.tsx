import { useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Header } from '@/components/Header';
import { ProjectsPage } from '@/pages/Projects';
import { RunsPage } from '@/pages/Runs';
import { RunDetailPage } from '@/pages/RunDetail';
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
            <Route path="/runs" element={<RunsPage refreshKey={refreshKey} />} />
            <Route path="/runs/:id" element={<RunDetailPage />} />
            <Route path="*" element={<ProjectsPage refreshKey={refreshKey} />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
