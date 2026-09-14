import { useEffect, useState } from 'react';
import { getToken } from './api';

/**
 * The gateway socket: connection state for the header, the effective run
 * settings (model chips), and this session's spend (sum of the run_report
 * messages received while the page is open). Numbers come from the gateway's
 * messages, never from the page.
 */
export type SocketState = 'connecting' | 'connected' | 'offline';

export interface Setting { name: string; label: string; value: string; fromEnv: boolean }

export interface GatewayState {
  socket: SocketState;
  settings: Setting[];
  sessionSpend: number;
  runsChanged: number;
}

type Listener = (s: GatewayState) => void;

let state: GatewayState = { socket: 'offline', settings: [], sessionSpend: 0, runsChanged: 0 };
const listeners = new Set<Listener>();
let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

function emit(patch: Partial<GatewayState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

function reportCost(report: Record<string, unknown> | undefined): number {
  const c = (report?.cost ?? {}) as Record<string, number | undefined>;
  const stab = (report?.stability ?? {}) as Record<string, number | undefined>;
  return (c.usd ?? 0) + (c.plannerUsd ?? 0) + (c.criticUsd ?? 0) + (stab.stabilizerCostUsd ?? 0);
}

export function connectGateway(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = getToken();
  const url = `${proto}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const sock = new WebSocket(url);
  ws = sock;
  emit({ socket: 'connecting' });
  sock.onopen = () => { if (sock === ws) emit({ socket: 'connected' }); };
  sock.onclose = () => {
    if (sock !== ws) return;
    emit({ socket: 'offline' });
    if (retry) clearTimeout(retry);
    retry = setTimeout(connectGateway, 4000);
  };
  sock.onerror = () => { if (sock === ws) emit({ socket: 'offline' }); };
  sock.onmessage = (e) => {
    if (sock !== ws) return;
    let data: Record<string, unknown>;
    try { data = JSON.parse(String(e.data)) as Record<string, unknown>; } catch { return; }
    if (data.type === 'settings' && Array.isArray(data.settings)) emit({ settings: data.settings as Setting[] });
    if (data.type === 'run_report' && !data.fromHistory) emit({ sessionSpend: state.sessionSpend + reportCost(data.report as Record<string, unknown>), runsChanged: state.runsChanged + 1 });
    if (data.type === 'runs') emit({ runsChanged: state.runsChanged + 1 });
  };
}

export function useGateway(): GatewayState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}
