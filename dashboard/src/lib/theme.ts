import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'qa-core.theme';

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* private mode */ }
  // Light is the default when nothing is stored (redesign v2); a saved choice is kept.
  return 'light';
}

export function applyTheme(t: Theme): void {
  document.documentElement.classList.toggle('light', t === 'light');
  document.documentElement.dataset.theme = t;
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => { applyTheme(theme); try { localStorage.setItem(KEY, theme); } catch { /* ignore */ } }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}
