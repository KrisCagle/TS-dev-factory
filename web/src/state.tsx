import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type EngineInfo, type FactoryStatus, type ServerState, type Stats } from './api';
import type { AgentConfig, AssistantTurn, AttentionItem, GameView, LogEvent, Pipeline, Project, ScarifFleet, Settings, Ticket, WorkSession } from './types';
import { usePrefs } from './prefs';

export type Celebration =
  | { type: 'xp'; amount: number; why: string }
  | { type: 'achievement'; achievement: { id: string; icon: string; title: string; desc: string }; xp: number }
  | { type: 'levelup'; level: number; title: string }
  | { type: 'quest'; quest: { id: string; icon: string; title: string; xp: number } }
  | { type: 'ship'; ticketId: string; key: string; title: string; xp: number; score?: number; firstTry: boolean };

export interface Notice { event: string; title: string; body: string; ticketId?: string }

interface FactoryState {
  ready: boolean;
  connected: boolean;
  /** tickets in the selected project (or all) */
  tickets: Ticket[];
  allTickets: Ticket[];
  projects: Project[];
  /** the selected project, or undefined for "All projects" */
  project?: Project;
  /** where new tickets go: the selected project, else the default one */
  targetProjectId: string;
  onNotice: (fn: (n: Notice) => void) => () => void;
  /** XP, level, streak, quests, achievements, agent cards. */
  game: GameView | null;
  /** Slack app connection status (Approve from Slack). */
  slackApp?: { connected: boolean; error?: string };
  /** subscribe to celebrations (ship, achievement, level-up, quest) */
  onCelebrate: (fn: (e: Celebration) => void) => () => void;
  attention: AttentionItem[];
  /** open items the PM can act on right now */
  needsYou: AttentionItem[];
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
  /** Claude Code sessions in your repos (the selected project's, or all). */
  sessions: WorkSession[];
  pipelines: Pipeline[];
  scarif: ScarifFleet | null;
  assistant: AssistantTurn[];
  engine: EngineInfo | null;
  /** New assistant turns as they arrive (the voice dock speaks replies). */
  onAssistant: (fn: (t: AssistantTurn) => void) => () => void;
}

const Ctx = createContext<FactoryState | null>(null);
const KIND_RANK: Record<AttentionItem['kind'], number> = { error: 0, permission: 1, review: 2, decision: 3, question: 4, todo: 5 };
const MAX_LOGS = 600;

export function FactoryProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<ServerState | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<(e: LogEvent) => void>());
  const noticeListeners = useRef(new Set<(n: Notice) => void>());
  const celebrateListeners = useRef(new Set<(e: Celebration) => void>());
  const assistantListeners = useRef(new Set<(t: AssistantTurn) => void>());
  const { prefs } = usePrefs();

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
          case 'notify':
            noticeListeners.current.forEach((fn) => fn(msg.notice));
            break;
          case 'attention':
            setS((p) => p && { ...p, attention: msg.attention });
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
          case 'game':
            setS((p) => p && { ...p, game: msg.game });
            break;
          case 'celebrate':
            celebrateListeners.current.forEach((fn) => fn(msg.event));
            break;
          case 'stats':
            setS((p) => p && { ...p, stats: msg.stats });
            break;
          case 'session':
            setS((p) => p && { ...p, sessions: upsertBy(p.sessions ?? [], msg.session) });
            break;
          case 'sessionDeleted':
            setS((p) => p && { ...p, sessions: (p.sessions ?? []).filter((x) => x.id !== msg.id) });
            break;
          case 'pipeline':
            setS((p) => p && { ...p, pipelines: upsertBy(p.pipelines ?? [], msg.pipeline) });
            break;
          case 'pipelineDeleted':
            setS((p) => p && { ...p, pipelines: (p.pipelines ?? []).filter((x) => x.id !== msg.id) });
            break;
          case 'scarif':
            setS((p) => p && { ...p, scarif: msg.fleet });
            break;
          case 'assistant':
            setS((p) => p && { ...p, assistant: [...(p.assistant ?? []).filter((t) => t.id !== msg.turn.id), msg.turn].slice(-100) });
            assistantListeners.current.forEach((fn) => fn(msg.turn));
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

  const value = useMemo<FactoryState>(() => {
    const projects = s?.settings.projects ?? [];
    const project = projects.find((p) => p.id === prefs.activeProject);
    const all = s?.tickets ?? [];
    const tickets = project ? all.filter((t) => t.projectId === project.id) : all;
    const ids = new Set(tickets.map((t) => t.id));
    const attention = (s?.attention ?? []).filter((a) => !project || a.projectId === project.id || (a.ticketId && ids.has(a.ticketId)));
    const inProject = <T extends { projectId: string }>(xs: T[] = []) => (project ? xs.filter((x) => x.projectId === project.id) : xs);
    return {
      ready: !!s,
      connected,
      tickets,
      allTickets: all,
      projects,
      project,
      targetProjectId: project?.id ?? s?.settings.defaultProjectId ?? 'default',
      onNotice: (fn) => {
        noticeListeners.current.add(fn);
        return () => noticeListeners.current.delete(fn);
      },
      game: s?.game ?? null,
      slackApp: s?.slackApp,
      onCelebrate: (fn) => {
        celebrateListeners.current.add(fn);
        return () => celebrateListeners.current.delete(fn);
      },
      attention,
      needsYou: attention.filter((a) => a.status === 'open').sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.createdAt - b.createdAt),
      agents: s?.agents ?? [],
      settings: s?.settings ?? null,
      factory: s?.factory ?? { running: [], paused: false },
      stats: s?.stats ?? null,
      connectors: s?.connectors ?? [],
      hasApiKey: s?.hasApiKey ?? false,
      logs: project ? logs.filter((l) => ids.has(l.ticketId)) : logs,
      onLog: (fn) => {
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      },
      refresh,
      sessions: inProject(s?.sessions).slice().sort((a, b) => b.updatedAt - a.updatedAt),
      pipelines: inProject(s?.pipelines).slice().sort((a, b) => b.createdAt - a.createdAt),
      scarif: s?.scarif ?? null,
      assistant: s?.assistant ?? [],
      engine: s?.engine ?? null,
      onAssistant: (fn: (t: AssistantTurn) => void) => {
        assistantListeners.current.add(fn);
        return () => assistantListeners.current.delete(fn);
      },
    };
  }, [s, logs, connected, prefs.activeProject]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function upsertBy<T extends { id: string }>(xs: T[], x: T) {
  const i = xs.findIndex((y) => y.id === x.id);
  if (i < 0) return [...xs, x];
  const next = xs.slice();
  next[i] = x;
  return next;
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
