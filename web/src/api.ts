import type { AgentConfig, AgentRole, AttentionItem, CaseVerdict, LogEvent, Settings, Ticket, TicketSource } from './types';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export interface Stats {
  total: number;
  done: number;
  inFlight: number;
  awaiting: number;
  ci: number;
  failed: number;
  costUsd: number;
  tokens: number;
  avgCycleMs: number;
  loopRate: number;
}

export interface FactoryStatus {
  running: string[];
  paused: boolean;
}

export interface HarvestStatus {
  configured: boolean;
  todayHours: number;
  entries: Array<{ id: number; hours: number; notes: string | null; project: string; task: string; running: boolean }>;
  running?: { entryId: number; notes: string | null; hours: number; ticketId?: string };
  error?: string;
  checkedAt: number;
}

export interface HarvestProject {
  id: number;
  name: string;
  code: string | null;
  client: string | null;
  tasks: Array<{ id: number; name: string }>;
}

export interface ServerState {
  tickets: Ticket[];
  attention: AttentionItem[];
  agents: AgentConfig[];
  settings: Settings;
  factory: FactoryStatus;
  stats: Stats;
  connectors: Array<{ source: TicketSource; label: string; enabled: boolean }>;
  hasApiKey: boolean;
}

export const api = {
  state: () => req<ServerState>('GET', '/api/state'),
  logs: (limit = 300) => req<LogEvent[]>('GET', `/api/logs?limit=${limit}`),
  ticketLogs: (id: string) => req<LogEvent[]>('GET', `/api/tickets/${id}/logs`),
  createTicket: (t: Partial<Ticket>) => req<Ticket>('POST', '/api/tickets', t),
  updateTicket: (id: string, t: Partial<Ticket>) => req<Ticket>('PATCH', `/api/tickets/${id}`, t),
  deleteTicket: (id: string) => req('DELETE', `/api/tickets/${id}`),
  approve: (id: string, note?: string) => req('POST', `/api/tickets/${id}/approve`, { note }),
  reject: (id: string, feedback: string) => req('POST', `/api/tickets/${id}/reject`, { feedback }),
  cancel: (id: string) => req('POST', `/api/tickets/${id}/cancel`),
  retry: (id: string) => req('POST', `/api/tickets/${id}/retry`),
  note: (id: string, text: string) => req('POST', `/api/tickets/${id}/notes`, { text }),
  updateAgent: (role: AgentRole, a: Partial<AgentConfig>) => req<AgentConfig>('PATCH', `/api/agents/${role}`, a),
  resetAgent: (role: AgentRole) => req<AgentConfig>('POST', `/api/agents/${role}/reset`),
  updateSettings: (s: Partial<Settings>) => req<Settings>('PATCH', '/api/settings', s),
  pause: (paused: boolean) => req('POST', '/api/factory/pause', { paused }),
  sync: (source: TicketSource) => req<{ fetched: number; created: number }>('POST', `/api/connectors/${source}/sync`),
  testConnector: (source: TicketSource) => req<{ message: string }>('POST', `/api/connectors/${source}/test`),
  demo: () => req('POST', '/api/demo'),
  resolve: (id: string, body: { option?: string; text?: string; verdicts?: CaseVerdict[]; notes?: string }) => req('POST', `/api/attention/${id}/resolve`, body),
  harvestStatus: (force = false) => req<HarvestStatus>('GET', `/api/harvest/status${force ? '?force=1' : ''}`),
  harvestProjects: () => req<HarvestProject[]>('GET', '/api/harvest/projects'),
  harvestTest: () => req<{ message: string }>('POST', '/api/harvest/test'),
  timerStart: (id: string, reason?: string) => req('POST', `/api/tickets/${id}/timer/start`, { reason }),
  timerStop: (id: string) => req<{ hours?: number }>('POST', `/api/tickets/${id}/timer/stop`),
  logTime: (id: string, hours: number, notes?: string) => req('POST', `/api/tickets/${id}/time`, { hours, notes }),
};
