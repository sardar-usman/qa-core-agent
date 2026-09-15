import { useEffect, useState } from 'react';

/**
 * Per-session overrides of the gateway's run settings (the RUN_ENV_SETTINGS
 * names: cost ceiling, repair reserve, max steps, the three model names).
 * Stored in this browser tab's sessionStorage only and sent as the `env` of
 * every command the Terminal starts, where the gateway applies them through
 * its existing per-run override (withEnvOverrides). Nothing is written to
 * disk or to the gateway's process.env permanently; one button clears them.
 */
const KEY = 'qa-core.session-overrides';

export type SessionOverrides = Record<string, string>;

const listeners = new Set<(o: SessionOverrides) => void>();

export function readOverrides(): SessionOverrides {
  try {
    const raw = sessionStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' ? Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === 'string' && v !== '')) as SessionOverrides : {};
  } catch { return {}; }
}

function write(o: SessionOverrides): void {
  try { if (Object.keys(o).length) sessionStorage.setItem(KEY, JSON.stringify(o)); else sessionStorage.removeItem(KEY); } catch { /* private mode */ }
  for (const l of listeners) l(o);
}

export function setOverride(name: string, value: string): void {
  const next = { ...readOverrides() };
  if (value.trim() === '') delete next[name]; else next[name] = value.trim();
  write(next);
}

export function clearOverrides(): void { write({}); }

export function useSessionOverrides(): SessionOverrides {
  const [o, setO] = useState<SessionOverrides>(readOverrides);
  useEffect(() => { listeners.add(setO); setO(readOverrides()); return () => { listeners.delete(setO); }; }, []);
  return o;
}
