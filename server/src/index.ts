import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { CONNECTORS, connectorFor } from './connectors/index.js';
import { harvest } from './connectors/harvest.js';
import { HarvestService } from './harvest-service.js';
import { Artifacts } from './artifacts.js';
import { FileBrowser } from './files.js';
import { Notifier } from './notifier.js';
import { Previews } from './previews.js';
import { Reports, type Range } from './reports.js';
import { Rules } from './rules.js';
import { Scoper } from './scoper.js';
import { Orchestrator } from './orchestrator.js';
import { Store } from './store.js';
import type { AgentRole, Priority, Stage, Ticket, TicketSource } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4317);
const DATA = process.env.FACTORY_DATA ?? path.resolve(__dirname, '../../.factory/db.json');

const store = new Store(DATA);
if (process.env.FACTORY_MODE === 'live' || process.env.FACTORY_MODE === 'mock') store.updateSettings({ mode: process.env.FACTORY_MODE });
if (process.env.FACTORY_REPO) {
  const s0 = store.settings();
  store.updateSettings({ projects: s0.projects.map((p) => (p.id === s0.defaultProjectId ? { ...p, repoPath: process.env.FACTORY_REPO! } : p)) });
}
const harvestSvc = new HarvestService(store);
const orch = new Orchestrator(store, harvestSvc);
const rules = new Rules(store);
const previews = new Previews(store);
const files = new FileBrowser(store);
const artifacts = new Artifacts(store);
const scoper = new Scoper(store);
// the websocket server is created further down; notifications go through this late-bound broadcaster
let broadcastLate: (msg: unknown) => void = () => undefined;
const notifier = new Notifier(store, (m) => broadcastLate(m));
const reports = new Reports(store, notifier);
orch.hooks = {
  rulesFor: (projectId) => rules.forPrompt(projectId),
  onFinished: (ticketId) => previews.stop(ticketId),
  afterTester: (ticketId, cwd) => artifacts.collect(ticketId, cwd),
  afterReview: (ticketId) => artifacts.link(ticketId),
};

const app = express();
app.use(express.json({ limit: '2mb' }));

const wrap = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    next(err);
  }
};

function stats() {
  const ts = store.tickets();
  const done = ts.filter((t) => t.stage === 'done' && t.finishedAt && t.startedAt);
  const cycle = done.length ? done.reduce((a, t) => a + (t.finishedAt! - t.startedAt!), 0) / done.length : 0;
  const reviewed = ts.filter((t) => t.review);
  return {
    total: ts.length,
    done: ts.filter((t) => t.stage === 'done').length,
    inFlight: ts.filter((t) => ['planning', 'coding', 'testing', 'reviewing'].includes(t.stage)).length,
    awaiting: store.attention().filter((a) => a.status === 'open').length,
    ci: ts.filter((t) => t.stage === 'ci').length,
    failed: ts.filter((t) => t.stage === 'failed').length,
    costUsd: +ts.reduce((a, t) => a + t.costUsd, 0).toFixed(4),
    tokens: ts.reduce((a, t) => a + t.tokens, 0),
    avgCycleMs: Math.round(cycle),
    loopRate: reviewed.length ? reviewed.filter((t) => t.iterations > 0).length / reviewed.length : 0,
  };
}

// ---------------------------------------------------------------- state
app.get('/api/state', wrap(() => ({
  tickets: store.tickets(),
  attention: store.attention(),
  agents: store.agents(),
  settings: store.publicSettings(),
  factory: orch.status(),
  stats: stats(),
  connectors: CONNECTORS.map((c) => ({ source: c.source, label: c.label, enabled: c.isEnabled(store.settings()) })),
  hasApiKey: !!process.env.ANTHROPIC_API_KEY,
})));

app.get('/api/logs', wrap((req) => store.logs(undefined, Number(req.query.limit ?? 300))));

// ---------------------------------------------------------------- tickets
app.post('/api/tickets', wrap((req) => {
  const b = req.body as Partial<Ticket>;
  if (!b.title?.trim()) throw Object.assign(new Error('title is required'), { status: 400 });
  return store.createTicket({
    title: b.title.trim(),
    description: b.description ?? '',
    priority: (b.priority ?? 'medium') as Priority,
    labels: b.labels ?? [],
    projectId: b.projectId,
    stage: b.stage === 'ready' ? 'ready' : 'backlog',
  });
}));

const PM_MOVABLE: Stage[] = ['backlog', 'ready'];

app.patch('/api/tickets/:id', wrap((req) => {
  const t = store.ticket(req.params.id);
  if (!t) throw Object.assign(new Error('not found'), { status: 404 });
  const { title, description, priority, labels, stage, order, harvest: hv } = req.body as Partial<Ticket>;
  const patch: Partial<Ticket> = {};
  if (hv !== undefined) patch.harvest = { ...(t.harvest ?? { loggedHours: 0 }), projectId: hv.projectId, taskId: hv.taskId };
  if (title !== undefined) patch.title = title;
  if (description !== undefined) patch.description = description;
  if (priority !== undefined) patch.priority = priority;
  if (labels !== undefined) patch.labels = labels;
  if (order !== undefined) patch.order = order;
  if (stage !== undefined && stage !== t.stage) {
    if (!PM_MOVABLE.includes(stage) || !['backlog', 'ready', 'failed', 'done'].includes(t.stage)) {
      throw Object.assign(new Error(`Can't move a ticket from ${t.stage} to ${stage} by hand — use approve/reject/cancel.`), { status: 400 });
    }
    patch.stage = stage;
    patch.error = undefined;
    store.log({ ticketId: t.id, agent: 'pm', kind: 'pm', text: `Moved to ${stage}` });
  }
  return store.updateTicket(t.id, patch);
}));

app.delete('/api/tickets/:id', wrap((req) => {
  orch.cancel(req.params.id);
  store.deleteTicket(req.params.id);
}));

app.get('/api/tickets/:id/logs', wrap((req) => store.logs(req.params.id, 2000)));
app.post('/api/tickets/:id/approve', wrap((req) => orch.approve(req.params.id, req.body?.note)));
app.post('/api/tickets/:id/reject', wrap((req) => {
  if (!req.body?.feedback) throw Object.assign(new Error('feedback is required'), { status: 400 });
  orch.reject(req.params.id, req.body.feedback);
}));
app.post('/api/tickets/:id/cancel', wrap((req) => orch.cancel(req.params.id)));
app.post('/api/tickets/:id/retry', wrap((req) => orch.retry(req.params.id)));
app.post('/api/tickets/:id/notes', wrap((req) => {
  orch.addNote(req.params.id, String(req.body?.text ?? ''));
  store.log({ ticketId: req.params.id, agent: 'pm', kind: 'pm', text: `Note: ${req.body?.text}` });
}));

// ---------------------------------------------------------------- projects: house rules
app.get('/api/projects/:id/rules', wrap((req) => ({ ...rules.get(req.params.id), suggestions: rules.suggestions(req.params.id) })));
app.put('/api/projects/:id/rules', wrap((req) => rules.set(req.params.id, String(req.body?.text ?? ''))));

// ---------------------------------------------------------------- previews, files, artifacts
app.post('/api/tickets/:id/preview/start', wrap((req) => previews.start(req.params.id)));
app.post('/api/tickets/:id/preview/stop', wrap((req) => previews.stop(req.params.id)));
app.get('/api/tickets/:id/preview/logs', wrap((req) => previews.logs(req.params.id)));
app.get('/api/tickets/:id/files', wrap((req) => files.list(req.params.id)));
app.get('/api/tickets/:id/file', wrap((req) => files.read(req.params.id, String(req.query.path ?? ''))));
app.post('/api/tickets/:id/open-editor', wrap((req) => files.openInEditor(req.params.id)));
app.get('/api/tickets/:id/artifacts/:aid', (req, res, next) => {
  try {
    res.sendFile(artifacts.file(req.params.id, req.params.aid));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- ticket writer
app.post('/api/scope', wrap((req) => scoper.draft(req.body ?? {})));

// ---------------------------------------------------------------- notifications & reports
app.post('/api/notifications/test', wrap(() => {
  notifier.notify({ event: 'needsYou', title: '🔔 Test notification', body: 'Notifications from AI Dev Factory are working.' }, { force: true });
}));
app.get('/api/reports', wrap((req) => reports.build((req.query.range === 'week' ? 'week' : 'day') as Range, (req.query.projectId as string) || undefined)));
app.post('/api/reports/slack', wrap((req) => reports.postToSlack(req.body?.range === 'week' ? 'week' : 'day', req.body?.projectId || undefined)));

// ---------------------------------------------------------------- the PM's inbox
app.get('/api/attention', wrap(() => store.attention()));
app.post('/api/attention/:id/resolve', wrap((req) => orch.resolve(req.params.id, req.body ?? {})));

// ---------------------------------------------------------------- Harvest
app.get('/api/harvest/status', wrap((req) => harvestSvc.status(req.query.force === '1')));
app.get('/api/harvest/projects', wrap(() => harvest.projects(store.settings())));
app.post('/api/harvest/test', wrap(async () => {
  const me = await harvest.me(store.settings());
  return { message: `Connected to Harvest as ${me.first_name} ${me.last_name}` };
}));
app.post('/api/tickets/:id/timer/start', wrap((req) => harvestSvc.startTimer(req.params.id, req.body?.reason)));
app.post('/api/tickets/:id/timer/stop', wrap(async (req) => ({ hours: await harvestSvc.stopTimer(req.params.id) })));
app.post('/api/tickets/:id/time', wrap((req) => harvestSvc.logTime(req.params.id, Number(req.body?.hours), req.body?.notes)));

// ---------------------------------------------------------------- agents & settings
app.patch('/api/agents/:role', wrap((req) => store.updateAgent(req.params.role as AgentRole, req.body)));
app.post('/api/agents/:role/reset', wrap((req) => store.resetAgent(req.params.role as AgentRole)));
app.patch('/api/settings', wrap((req) => {
  store.updateSettings(req.body);
  harvestSvc.invalidate();
  return store.publicSettings();
}));
app.post('/api/factory/pause', wrap((req) => orch.setPaused(Boolean(req.body?.paused))));

// ---------------------------------------------------------------- connectors
app.post('/api/connectors/:source/sync', wrap(async (req) => {
  const c = connectorFor(req.params.source as TicketSource);
  if (!c) throw Object.assign(new Error('unknown connector'), { status: 404 });
  const s = store.settings();
  if (!c.isEnabled(s)) throw Object.assign(new Error(`${c.label} is not configured`), { status: 400 });
  const incoming = await c.pull(s);
  let created = 0;
  for (const it of incoming) {
    const existing = store.tickets().find((t) => t.source === c.source && t.externalId === it.externalId);
    if (existing) {
      if (['backlog', 'ready'].includes(existing.stage)) store.updateTicket(existing.id, { title: it.title, description: it.description, priority: it.priority, labels: it.labels });
      continue;
    }
    store.createTicket({ ...it, source: c.source, stage: 'backlog', projectId: (req.body?.projectId as string | undefined) ?? undefined });
    created++;
  }
  return { fetched: incoming.length, created };
}));

app.post('/api/connectors/:source/test', wrap(async (req) => {
  const c = connectorFor(req.params.source as TicketSource);
  if (!c) throw Object.assign(new Error('unknown connector'), { status: 404 });
  return { message: await c.test(store.settings()) };
}));

// ---------------------------------------------------------------- demo data
app.post('/api/demo', wrap((req) => {
  const demo: Array<[string, Priority, string, string[]]> = [
    ['Add dark mode toggle to settings page', 'high', 'Users want a dark theme. Persist choice per user and respect the OS preference by default.', ['frontend', 'ux']],
    ['Rate-limit the public /search endpoint', 'urgent', 'We are getting scraped. 60 req/min per IP, return 429 with Retry-After.', ['backend', 'security']],
    ['Fix date formatting on invoices', 'medium', 'Invoices show ISO timestamps. Use the account locale.', ['bug', 'billing']],
    ['Add CSV export to the reports table', 'medium', 'Export the currently filtered rows. Include headers.', ['frontend']],
    ['Upgrade logger and remove console.log calls', 'low', 'Replace stray console.log with the structured logger.', ['chore']],
    ['Password reset emails expire too fast', 'high', 'Token TTL is 5 minutes; should be 60. Add a test.', ['bug', 'auth']],
  ];
  const projectId = req.body?.projectId as string | undefined;
  demo.forEach(([title, priority, description, labels], i) => store.createTicket({ title, priority, description, labels, projectId, stage: i < 4 ? 'ready' : 'backlog' }));
}));

// ---------------------------------------------------------------- static web build
const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.status ?? 500).json({ error: err.message });
});

// ---------------------------------------------------------------- websocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const broadcast = (msg: unknown) => {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
};
broadcastLate = broadcast;
let statsTimer: NodeJS.Timeout | null = null;
const pushStats = () => {
  if (statsTimer) return;
  statsTimer = setTimeout(() => { statsTimer = null; broadcast({ type: 'stats', stats: stats() }); }, 500);
};
store.on('ticket', (ticket) => { broadcast({ type: 'ticket', ticket }); pushStats(); });
store.on('ticketDeleted', (id) => { broadcast({ type: 'ticketDeleted', id }); pushStats(); });
store.on('log', (event) => broadcast({ type: 'log', event }));
store.on('agents', (agents) => broadcast({ type: 'agents', agents }));
store.on('settings', (settings) => broadcast({ type: 'settings', settings }));
store.on('factory', (factory) => broadcast({ type: 'factory', factory }));
store.on('attention', (attention) => { broadcast({ type: 'attention', attention }); pushStats(); });

server.listen(PORT, () => {
  orch.start();
  reports.startSchedule();
  const s = store.settings();
  console.log(`\n🏭 AI Dev Factory on http://localhost:${PORT}  (mode: ${s.mode}, ${s.projects.length} project${s.projects.length === 1 ? '' : 's'})\n`);
});

const shutdown = () => {
  orch.stop();
  previews.stopAll();
  store.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
