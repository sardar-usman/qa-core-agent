import { useEffect, useState } from 'react';
import { getToken } from './api';

/**
 * The gateway socket: connection state for the header, the effective run
 * settings (model chips), this session's spend (sum of the run_report
 * messages received while the page is open), the run in progress on the
 * gateway, and the live run this tab is following. Numbers come from the
 * gateway's messages, never from the page.
 *
 * Live run protocol (src/server/gateway.ts): run_started (with run_id and
 * run_dir), one `event` per AgentEvent, console-style {text} lines, and the
 * closing run_report or run_failed. After a reconnect the tab sends
 * catch_up for the run it was following and receives the run folder's
 * events.jsonl (and the report when finished); memory is never the source.
 */
export type SocketState = 'connecting' | 'connected' | 'offline';

export interface Setting { name: string; label: string; value: string; fromEnv: boolean }

export interface LiveEvent { t: string; type: string; [k: string]: unknown }

export interface LiveRun {
  runId: string;
  runDir: string | null;
  command: 'explore' | 'resume';
  request: Record<string, unknown>;
  startedAt: string;
  events: LiveEvent[];
  /** The runtime's console-style lines. Rendered in the log only; never read as a number. */
  log: string[];
  status: 'running' | 'finished' | 'failed';
  error: string | null;
  report: Record<string, unknown> | null;
  outcome: Record<string, unknown> | null;
  /** True after a catch_up replaced the in-memory events with the run folder's. */
  caughtUp: boolean;
}

export interface ActiveRun { run_id: string; run_dir: string; url: string; started_at: string }

export interface GatewayState {
  socket: SocketState;
  settings: Setting[];
  sessionSpend: number;
  runsChanged: number;
  activeRun: ActiveRun | null;
  live: LiveRun | null;
  /** The last error text the gateway sent for a command that never became a run. */
  lastError: string | null;
}

type Listener = (s: GatewayState) => void;

let state: GatewayState = { socket: 'offline', settings: [], sessionSpend: 0, runsChanged: 0, activeRun: null, live: null, lastError: null };
const listeners = new Set<Listener>();
let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
/** Set while a command has been sent and no run_started has arrived yet. */
let pendingStart = false;

function emit(patch: Partial<GatewayState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

function reportCost(report: Record<string, unknown> | undefined): number {
  const c = (report?.cost ?? {}) as Record<string, number | undefined>;
  const stab = (report?.stability ?? {}) as Record<string, number | undefined>;
  return (c.usd ?? 0) + (c.plannerUsd ?? 0) + (c.criticUsd ?? 0) + (stab.stabilizerCostUsd ?? 0);
}

function patchLive(patch: Partial<LiveRun>): void {
  if (!state.live) return;
  emit({ live: { ...state.live, ...patch } });
}

export function connectGateway(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = getToken();
  const url = `${proto}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const sock = new WebSocket(url);
  ws = sock;
  emit({ socket: 'connecting' });
  sock.onopen = () => {
    if (sock !== ws) return;
    emit({ socket: 'connected' });
    // Back after a drop mid-run: rebuild from the run folder, not from what this tab remembers.
    if (state.live && state.live.status === 'running') sock.send(JSON.stringify({ type: 'catch_up', run_id: state.live.runId }));
  };
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
    handleMessage(data);
  };
}

function handleMessage(data: Record<string, unknown>): void {
  const now = new Date().toISOString();
  const runId = typeof data.run_id === 'string' ? data.run_id : null;
  const forLive = (): boolean => !!state.live && (runId === null || runId === state.live.runId);
  switch (data.type) {
    case 'settings':
      if (Array.isArray(data.settings)) emit({ settings: data.settings as Setting[] });
      return;
    case 'active_run':
      emit({ activeRun: (data.run as ActiveRun | null) ?? null });
      return;
    case 'runs':
      emit({ runsChanged: state.runsChanged + 1 });
      return;
    case 'run_started': {
      if (!runId) return;
      pendingStart = false;
      emit({
        lastError: null,
        live: {
          runId, runDir: typeof data.run_dir === 'string' ? data.run_dir : null,
          command: data.command === 'resume' ? 'resume' : 'explore',
          request: (data.request as Record<string, unknown>) ?? {},
          startedAt: now, events: [], log: [], status: 'running', error: null, report: null, outcome: null, caughtUp: false,
        },
      });
      return;
    }
    case 'event': {
      if (!forLive() || !data.event || typeof data.event !== 'object') return;
      const ev = { t: now, ...(data.event as Record<string, unknown>) } as LiveEvent;
      patchLive({ events: [...state.live!.events, ev] });
      return;
    }
    case 'run_report': {
      if (data.fromHistory) return;
      emit({ sessionSpend: state.sessionSpend + reportCost(data.report as Record<string, unknown>), runsChanged: state.runsChanged + 1 });
      if (forLive()) patchLive({ status: 'finished', report: (data.report as Record<string, unknown>) ?? null, outcome: (data.outcome as Record<string, unknown>) ?? null });
      return;
    }
    case 'run_failed': {
      const error = String(data.error ?? 'the run failed');
      if (forLive() && state.live!.status === 'running') patchLive({ status: 'failed', error });
      if (pendingStart) { pendingStart = false; emit({ lastError: error }); }
      return;
    }
    case 'catch_up': {
      if (!forLive()) return;
      if (data.found === false) { patchLive({ status: 'failed', error: `run ${state.live!.runId} was not found in the output folder`, caughtUp: true }); return; }
      const events = Array.isArray(data.events) ? (data.events as LiveEvent[]) : [];
      const report = (data.report as Record<string, unknown> | null) ?? null;
      patchLive({
        events, caughtUp: true,
        runDir: typeof data.run_dir === 'string' ? data.run_dir : state.live!.runDir,
        ...(report ? { status: 'finished' as const, report, outcome: (data.outcome as Record<string, unknown> | null) ?? null } : {}),
      });
      return;
    }
    default:
      if (typeof data.text === 'string') {
        if (state.live && state.live.status === 'running') patchLive({ log: [...state.live.log, data.text] });
        if (pendingStart && /^✗/.test(data.text)) { pendingStart = false; emit({ lastError: data.text.replace(/^✗\s*/, '') }); }
      }
  }
}

/** Send a slash command the same way the legacy UI does: {type:'message', content, lang, srs?}. */
export function startCommand(input: { content: string; lang: 'ts' | 'js'; srs?: { name: string; base64: string } }): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  pendingStart = true;
  emit({ lastError: null });
  ws.send(JSON.stringify({ type: 'message', content: input.content, lang: input.lang, ...(input.srs ? { srs: input.srs } : {}) }));
  return true;
}

/** Follow a run this tab did not start (a reload mid-run): catch up from its folder, then watch. */
export function followRun(runId: string): void {
  if (state.live?.runId === runId) return;
  emit({ live: { runId, runDir: null, command: 'explore', request: {}, startedAt: new Date().toISOString(), events: [], log: [], status: 'running', error: null, report: null, outcome: null, caughtUp: false } });
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'catch_up', run_id: runId }));
}

/** Forget the live run once its detail page has been rendered from the report. */
export function clearLive(runId: string): void {
  if (state.live?.runId === runId) emit({ live: null });
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
