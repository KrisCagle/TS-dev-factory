import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type FactoryStatus, type ServerState, type Stats } from './api';
import type { AgentConfig, LogEvent, Settings, Ticket } from './types';

interface FactoryState {
  ready: boolean;
  connected: boolean;
  tickets: Ticket[];
  agents: AgentConfig[];
  settings: Settings | null;
  factory: FactoryStatus;
  stats: Stats | null;
  connectors: ServerState['connectors'];
  hasApiKey: boolean;
  logs: LogEvent[];
  /** subscribe to raw log events (used by the office for speech bubbles) */
  onLog: (fn: (e: LogEvent) => void) => () => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<FactoryState | null>(null);
const MAX_LOGS = 600;

export function FactoryProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<ServerState | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<(e: LogEvent) => void>());

  const refresh = async () => {
    const [state, l] = await Promise.all([api.state(), api.logs(MAX_LOGS)]);
    setS(state);
    setLogs(l);
  };

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: number | undefined;
    let alive = true;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        setConnected(true);
        refresh().catch(console.error);
      };
      ws.onclose = () => {
        setConnected(false);
        if (alive) retry = window.setTimeout(connect, 1500);
      };
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        switch (msg.type) {
          case 'ticket':
            setS((p) => p && { ...p, tickets: upsert(p.tickets, msg.ticket) });
            break;
          case 'ticketDeleted':
            setS((p) => p && { ...p, tickets: p.tickets.filter((t) => t.id !== msg.id) });
            break;
          case 'log':
            setLogs((p) => (p.length >= MAX_LOGS ? [...p.slice(-MAX_LOGS + 1), msg.event] : [...p, msg.event]));
            listeners.current.forEach((fn) => fn(msg.event));
            break;
          case 'agents':
            setS((p) => p && { ...p, agents: msg.agents });
            break;
          case 'settings':
            setS((p) => p && { ...p, settings: msg.settings });
            break;
          case 'factory':
            setS((p) => p && { ...p, factory: msg.factory });
            break;
          case 'stats':
            setS((p) => p && { ...p, stats: msg.stats });
            break;
        }
      };
    };
    connect();
    return () => {
      alive = false;
      window.clearTimeout(retry);
      ws?.close();
    };
  }, []);

  const value = useMemo<FactoryState>(
    () => ({
      ready: !!s,
      connected,
      tickets: s?.tickets ?? [],
      agents: s?.agents ?? [],
      settings: s?.settings ?? null,
      factory: s?.factory ?? { running: [], paused: false },
      stats: s?.stats ?? null,
      connectors: s?.connectors ?? [],
      hasApiKey: s?.hasApiKey ?? false,
      logs,
      onLog: (fn) => {
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      },
      refresh,
    }),
    [s, logs, connected],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function upsert(ts: Ticket[], t: Ticket) {
  const i = ts.findIndex((x) => x.id === t.id);
  if (i < 0) return [...ts, t];
  const next = ts.slice();
  next[i] = t;
  return next;
}

export function useFactory() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useFactory outside provider');
  return c;
}
