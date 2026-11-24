import type { GameView, AgentConfig, AgentRole, AttentionItem, CaseVerdict, LogEvent, Settings, Ticket, TicketSource } from './types';

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

export interface Report {
  range: 'day' | 'week';
  from: string;
  to: string;
  project: string;
  shipped: Array<{ key: string; title: string; prUrl?: string }>;
  needsYou: Array<{ key: string; title: string }>;
  inProgress: Array<{ key: string; title: string; stage: string }>;
  blocked: Array<{ key: string; title: string; why: string }>;
  spendUsd: number;
  harvestHours?: number;
  highlight?: { key: string; title: string; why: string };
  markdown: string;
}

export interface PluginsSummary {
  dir: string;
  plugins: Array<{ name: string; file: string; description?: string; enabled: boolean; error?: string; roles: string[]; gates: string[]; sources: string[]; rooms: string[] }>;
  rooms: Array<{ id: string; label: string; icon?: string; plugin: string }>;
  sources: Array<{ id: string; label: string; plugin: string }>;
}

export interface CatchUp {
  since: number;
  awayMs: number;
  headline: string;
  shipped: Array<{ id: string; key: string; title: string }>;
  needsYou: Array<{ id: string; ticketId?: string; title: string; isNew: boolean }>;
  problems: Array<{ id: string; key: string; title: string; what: string }>;
  started: Array<{ id: string; key: string; title: string; stage: string }>;
  spendUsd: number;
  quiet: boolean;
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
  game: GameView;
  slackApp?: { connected: boolean; error?: string };
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
  revert: (id: string, opts: { redo?: boolean; note?: string } = {}) => req<{ redo?: Ticket }>('POST', `/api/tickets/${id}/revert`, opts),
  smoke: (id: string) => req('POST', `/api/tickets/${id}/smoke`),
  game: () => req<GameView>('GET', '/api/game'),
  plugins: () => req<PluginsSummary>('GET', '/api/plugins'),
  pluginSync: (id: string, projectId?: string) => req<{ fetched: number; created: number }>('POST', `/api/plugins/sources/${id}/sync`, { projectId }),
  slackAppTest: () => req<{ message: string }>('POST', '/api/slack-app/test'),
  takeover: (id: string, openEditor = true) => req<{ worktree?: string }>('POST', `/api/tickets/${id}/takeover`, { openEditor }),
  handback: (id: string, note?: string) => req('POST', `/api/tickets/${id}/handback`, { note }),
  ask: (id: string, question: string) => req<{ q: string; a: string }>('POST', `/api/tickets/${id}/ask`, { question }),
  catchup: (since: number, projectId?: string) => req<CatchUp>('GET', `/api/catchup?since=${since}${projectId ? `&projectId=${projectId}` : ''}`),
  note: (id: string, text: string) => req('POST', `/api/tickets/${id}/notes`, { text }),
  updateAgent: (role: AgentRole, a: Partial<AgentConfig>) => req<AgentConfig>('PATCH', `/api/agents/${role}`, a),
  resetAgent: (role: AgentRole) => req<AgentConfig>('POST', `/api/agents/${role}/reset`),
  updateSettings: (s: Partial<Settings>) => req<Settings>('PATCH', '/api/settings', s),
  pause: (paused: boolean) => req('POST', '/api/factory/pause', { paused }),
  sync: (source: TicketSource, projectId?: string) => req<{ fetched: number; created: number }>('POST', `/api/connectors/${source}/sync`, { projectId }),
  testConnector: (source: TicketSource) => req<{ message: string }>('POST', `/api/connectors/${source}/test`),
  demo: (projectId?: string) => req('POST', '/api/demo', { projectId }),
  scope: (body: { text: string; projectId?: string; answers?: Array<{ q: string; a: string }> }) =>
    req<{ title: string; description: string; priority: Ticket['priority']; labels: string[]; questions: string[] }>('POST', '/api/scope', body),
  rules: (projectId: string) => req<{ text: string; where: string; inRepo: boolean; suggestions: Array<{ text: string; ticket: string; ts: number }> }>('GET', `/api/projects/${projectId}/rules`),
  saveRules: (projectId: string, text: string) => req<{ text: string; where: string; inRepo: boolean }>('PUT', `/api/projects/${projectId}/rules`, { text }),
  previewStart: (id: string) => req('POST', `/api/tickets/${id}/preview/start`),
  previewStop: (id: string) => req('POST', `/api/tickets/${id}/preview/stop`),
  previewLogs: (id: string) => req<string[]>('GET', `/api/tickets/${id}/preview/logs`),
  files: (id: string) => req<{ changed: string[]; files: string[]; live: boolean }>('GET', `/api/tickets/${id}/files`),
  file: (id: string, path: string) => req<{ path: string; content: string; fromDiff?: boolean; tooLarge?: boolean; binary?: boolean }>('GET', `/api/tickets/${id}/file?path=${encodeURIComponent(path)}`),
  openEditor: (id: string) => req<{ opened: string }>('POST', `/api/tickets/${id}/open-editor`),
  artifactUrl: (ticketId: string, artifactId: string) => `/api/tickets/${ticketId}/artifacts/${artifactId}`,
  testNotification: () => req('POST', '/api/notifications/test'),
  report: (range: 'day' | 'week', projectId?: string) => req<Report>('GET', `/api/reports?range=${range}${projectId ? `&projectId=${projectId}` : ''}`),
  reportToSlack: (range: 'day' | 'week', projectId?: string) => req<Report>('POST', '/api/reports/slack', { range, projectId }),
  resolve: (id: string, body: { option?: string; text?: string; verdicts?: CaseVerdict[]; notes?: string }) => req('POST', `/api/attention/${id}/resolve`, body),
  harvestStatus: (force = false) => req<HarvestStatus>('GET', `/api/harvest/status${force ? '?force=1' : ''}`),
  harvestProjects: () => req<HarvestProject[]>('GET', '/api/harvest/projects'),
  harvestTest: () => req<{ message: string }>('POST', '/api/harvest/test'),
  timerStart: (id: string, reason?: string) => req('POST', `/api/tickets/${id}/timer/start`, { reason }),
  timerStop: (id: string) => req<{ hours?: number }>('POST', `/api/tickets/${id}/timer/stop`),
  logTime: (id: string, hours: number, notes?: string) => req('POST', `/api/tickets/${id}/time`, { hours, notes }),
};
