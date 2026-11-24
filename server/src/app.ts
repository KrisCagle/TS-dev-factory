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
import { Game } from './game.js';
import { Asker } from './asker.js';
import { catchUp } from './catchup.js';
import { Plugins } from './plugins.js';
import { SlackApp } from './slack-app.js';
import { toTicket as sentryTicket, verifySignature } from './connectors/sentry.js';
import { Orchestrator } from './orchestrator.js';
import { Store } from './store.js';
import type { AgentRole, Priority, Stage, Ticket, TicketSource } from './types.js';
import type { MockOptions } from './agents/mock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface FactoryOptions {
  /** Where the JSON database lives. */
  dataFile: string;
  /** Force simulated or live agents (otherwise the saved setting is used). */
  mode?: 'live' | 'mock';
  /** Point the default project at this repo. */
  repoPath?: string;
  /** Simulated-agent knobs, used by tests and demos. */
  mock?: MockOptions;
  /** Scales the factory's timers in simulated mode (1 = demo pace). */
  speed?: number;
  /** Serve the built web UI (default true). */
  serveWeb?: boolean;
  /** Post the daily standup on schedule (default true). */
  schedules?: boolean;
  /** Folder of factory plugins (default: plugins/ in the repo; set to '' to load none). */
  pluginsDir?: string;
  /** Override how plugin files are imported (tests). */
  pluginImporter?: (file: string) => Promise<Record<string, unknown>>;
}

/** Builds the whole factory — store, orchestrator, services, REST + WebSocket API — without listening yet. */
export function createFactory(opts: FactoryOptions) {
  const store = new Store(opts.dataFile);
  if (opts.mode) store.updateSettings({ mode: opts.mode });
  if (opts.repoPath) {
    const s0 = store.settings();
    store.updateSettings({ projects: s0.projects.map((p) => (p.id === s0.defaultProjectId ? { ...p, repoPath: opts.repoPath! } : p)) });
  }
  const harvestSvc = new HarvestService(store);
  const orch = new Orchestrator(store, harvestSvc, { mock: opts.mock, speed: opts.speed });
  const rules = new Rules(store);
  const previews = new Previews(store);
  const files = new FileBrowser(store);
  const artifacts = new Artifacts(store);
  const scoper = new Scoper(store);
  // the websocket server is created further down; notifications go through this late-bound broadcaster
  let broadcastLate: (msg: unknown) => void = () => undefined;
  const notifier = new Notifier(store, (m) => broadcastLate(m));
  const reports = new Reports(store, notifier);
  const asker = new Asker(store);
  const pluginsDir = opts.pluginsDir ?? process.env.FACTORY_PLUGINS_DIR ?? path.resolve(__dirname, '../../plugins');
  const plugins = new Plugins(store, pluginsDir, opts.pluginImporter);
  const pluginsReady = pluginsDir ? plugins.load().catch((e) => console.error('[plugins]', e)) : Promise.resolve();
  store.on('settings', () => plugins.refreshEnabled());
  const slackApp = new SlackApp(store, orch);
  const game = new Game(store, (event) => broadcastLate({ type: 'celebrate', event }));
  orch.hooks = {
    plugins,
    rulesFor: (projectId) => rules.forPrompt(projectId),
    onFinished: (ticketId) => previews.stop(ticketId),
    afterTester: (ticketId, cwd) => artifacts.collect(ticketId, cwd),
    afterReview: (ticketId) => artifacts.link(ticketId),
  };

  const app = express();
  // keep the raw body for webhook signature checks
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));

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
    game: game.view(),
    slackApp: slackApp.status,
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

  /** Validate "waits on": real tickets, not itself, no cycles. */
  const checkDeps = (t: Ticket, deps: unknown): string[] => {
    if (!Array.isArray(deps)) throw Object.assign(new Error('dependsOn must be a list of ticket ids'), { status: 400 });
    const ids = [...new Set(deps.map(String))];
    for (const d of ids) {
      if (d === t.id) throw Object.assign(new Error('A ticket can’t wait on itself.'), { status: 400 });
      if (!store.ticket(d)) throw Object.assign(new Error(`Unknown ticket ${d}`), { status: 400 });
    }
    // would t be reachable from its own dependencies?
    const seen = new Set<string>();
    const stack = [...ids];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === t.id) throw Object.assign(new Error('That would create a loop of tickets waiting on each other.'), { status: 400 });
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(store.ticket(cur)?.dependsOn ?? []));
    }
    return ids;
  };

  app.patch('/api/tickets/:id', wrap((req) => {
    const t = store.ticket(req.params.id);
    if (!t) throw Object.assign(new Error('not found'), { status: 404 });
    const { title, description, priority, labels, stage, order, harvest: hv, dependsOn } = req.body as Partial<Ticket>;
    const patch: Partial<Ticket> = {};
    if (dependsOn !== undefined) patch.dependsOn = checkDeps(t, dependsOn);
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
  app.post('/api/tickets/:id/takeover', wrap(async (req) => {
    const r = orch.takeOver(req.params.id);
    if (req.body?.openEditor && r.worktree) await files.openInEditor(req.params.id).catch(() => undefined);
    return r;
  }));
  app.post('/api/tickets/:id/handback', wrap((req) => orch.handBack(req.params.id, req.body?.note ? String(req.body.note) : undefined)));
  app.post('/api/tickets/:id/ask', wrap((req) => asker.ask(req.params.id, String(req.body?.question ?? ''))));
  app.get('/api/catchup', wrap((req) => catchUp(store, Number(req.query.since) || Date.now() - 3_600_000, (req.query.projectId as string) || undefined)));
  app.post('/api/tickets/:id/revert', wrap((req) => orch.revert(req.params.id, { redo: !!req.body?.redo, note: req.body?.note ? String(req.body.note) : undefined })));
  app.post('/api/tickets/:id/smoke', wrap((req) => {
    if (!store.ticket(req.params.id)?.ship) throw Object.assign(new Error('This ticket hasn’t shipped yet.'), { status: 409 });
    void orch.smoke(req.params.id);
  }));
  app.post('/api/tickets/:id/notes', wrap((req) => {
    if (!store.ticket(req.params.id)) throw Object.assign(new Error('not found'), { status: 404 });
    if (!String(req.body?.text ?? '').trim()) throw Object.assign(new Error('text is required'), { status: 400 });
    orch.addNote(req.params.id, String(req.body?.text ?? ''));
    store.log({ ticketId: req.params.id, agent: 'pm', kind: 'pm', text: `Note: ${req.body?.text}` });
  }));

  // ---------------------------------------------------------------- projects: house rules
  app.get('/api/projects/:id/rules', wrap((req) => ({ ...rules.get(req.params.id), suggestions: rules.suggestions(req.params.id) })));
  app.put('/api/projects/:id/rules', wrap((req) => {
    const r = rules.set(req.params.id, String(req.body?.text ?? ''));
    if (r.text.trim()) store.emit('game:event', { type: 'rules' });
    return r;
  }));

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
  app.post('/api/scope', wrap(async (req) => {
    const d = await scoper.draft(req.body ?? {});
    if (!req.body?.answers?.length) store.emit('game:event', { type: 'scoped' });
    return d;
  }));
  app.get('/api/game', wrap(() => game.view()));
  app.post('/api/slack-app/test', wrap(async () => {
    const s = store.settings().slackApp;
    if (!s.enabled) throw Object.assign(new Error('Turn on the Slack app first.'), { status: 400 });
    return { message: await slackApp.test() };
  }));

  // ---------------------------------------------------------------- plugins
  app.get('/api/plugins', wrap(() => plugins.summary()));
  app.post('/api/plugins/sources/:id/sync', wrap(async (req) => {
    const src = plugins.source(req.params.id);
    if (!src) throw Object.assign(new Error('No enabled plugin source with that id'), { status: 404 });
    const items = await src.pull();
    let created = 0;
    for (const it of items) {
      const externalId = `${src.id}:${it.externalId}`;
      const existing = store.tickets().find((t) => t.source === 'plugin' && t.externalId === externalId);
      if (existing) continue;
      store.createTicket({ title: it.title, description: it.description ?? '', priority: it.priority ?? 'medium', labels: it.labels ?? [], externalId, externalUrl: it.externalUrl, source: 'plugin', stage: 'backlog', projectId: req.body?.projectId });
      created++;
    }
    return { fetched: items.length, created };
  }));

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
  /** Import from a tracker into Backlog; existing tickets get refreshed while they're still waiting. */
  const importFrom = async (c: NonNullable<ReturnType<typeof connectorFor>>, projectId?: string) => {
    const incoming = await c.pull(store.settings());
    let created = 0;
    for (const it of incoming) {
      const existing = store.tickets().find((t) => t.source === c.source && t.externalId === it.externalId);
      if (existing) {
        if (['backlog', 'ready'].includes(existing.stage)) store.updateTicket(existing.id, { title: it.title, description: it.description, priority: it.priority, labels: it.labels });
        continue;
      }
      store.createTicket({ ...it, source: c.source, stage: 'backlog', projectId });
      created++;
    }
    return { fetched: incoming.length, created };
  };

  app.post('/api/connectors/:source/sync', wrap(async (req) => {
    const c = connectorFor(req.params.source as TicketSource);
    if (!c) throw Object.assign(new Error('unknown connector'), { status: 404 });
    if (!c.isEnabled(store.settings())) throw Object.assign(new Error(`${c.label} is not configured`), { status: 400 });
    return importFrom(c, (req.body?.projectId as string | undefined) ?? undefined);
  }));

  // Sentry can push new issues to us instead of waiting for an import (needs a URL Sentry can reach).
  app.post('/api/webhooks/sentry', wrap((req) => {
    const s = store.settings().connectors.sentry;
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    if (!s.enabled || !verifySignature(raw, req.header('sentry-hook-signature'), s.webhookSecret)) throw Object.assign(new Error('Invalid signature'), { status: 401 });
    const issue = req.body?.data?.issue;
    if (req.header('sentry-hook-resource') !== 'issue' || req.body?.action !== 'created' || !issue?.id) return { ignored: true };
    if (store.tickets().some((t) => t.source === 'sentry' && t.externalId === String(issue.id))) return { duplicate: true };
    const t = store.createTicket({ ...sentryTicket(issue), source: 'sentry', stage: 'backlog' });
    return { created: t.key };
  }));

  // optional: pull new Sentry issues every 10 minutes
  const sentryTimer = setInterval(() => {
    const s = store.settings();
    const c = connectorFor('sentry');
    if (c && s.connectors.sentry.autoImport && c.isEnabled(s)) void importFrom(c).catch((e) => console.error('[sentry] auto-import:', e.message));
  }, 10 * 60_000);
  sentryTimer.unref();

  app.post('/api/connectors/:source/test', wrap(async (req) => {
    const c = connectorFor(req.params.source as TicketSource);
    if (!c) throw Object.assign(new Error('unknown connector'), { status: 404 });
    return { message: await c.test(store.settings()) };
  }));

  // ---------------------------------------------------------------- demo data
  app.post('/api/demo', wrap((req) => {
    const ac = (...xs: string[]) => `\n\n## Acceptance criteria\n${xs.map((x) => `- [ ] ${x}`).join('\n')}`;
    const demo: Array<[string, Priority, string, string[]]> = [
      ['Add dark mode toggle to settings page', 'high', `Users want a dark theme.${ac('A toggle on the settings page switches between light and dark', 'The choice is remembered per user', 'New users get their OS preference by default')}`, ['frontend', 'ux']],
      ['Rate-limit the public /search endpoint', 'urgent', `We are getting scraped.${ac('More than 60 requests a minute from one IP get a 429', 'The 429 includes a Retry-After header', 'Signed-in users are not limited')}`, ['backend', 'security']],
      ['Fix date formatting on invoices', 'medium', `Invoices show ISO timestamps.${ac('Invoice dates use the account locale', 'PDF and email invoices match')}`, ['bug', 'billing']],
      ['Add CSV export to the reports table', 'medium', `Export the currently filtered rows.${ac('An Export CSV button downloads the filtered rows', 'The file has a header row', 'Commas and quotes in values are escaped')}`, ['frontend']],
      ['Upgrade logger and remove console.log calls', 'low', `Replace stray console.log with the structured logger.${ac('No console.log calls remain in src/', 'Logs include the request ID')}`, ['chore']],
      ['Password reset emails expire too fast', 'high', `Token TTL is 5 minutes; should be 60.${ac('Reset links work for 60 minutes', 'Expired links show a clear message with a way to resend')}`, ['bug', 'auth']],
    ];
    const projectId = req.body?.projectId as string | undefined;
    demo.forEach(([title, priority, description, labels], i) => store.createTicket({ title, priority, description, labels, projectId, stage: i < 4 ? 'ready' : 'backlog' }));
  }));

  // ---------------------------------------------------------------- static web build
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (opts.serveWeb !== false && fs.existsSync(webDist)) {
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
  store.on('game', (g) => broadcast({ type: 'game', game: g }));

  let started = false;
  return {
    app,
    server,
    store,
    orch,
    game,
    plugins,
    pluginsReady,
    slackApp,
    /** Start listening and start the agents' scheduler. Resolves with the bound port. */
    async listen(port: number) {
      await pluginsReady;
      return new Promise<number>((resolve) => {
        server.listen(port, () => {
          started = true;
          orch.start();
          slackApp.start();
          if (opts.schedules !== false) reports.startSchedule();
          resolve((server.address() as { port: number }).port);
        });
      });
    },
    /** Stop agents, previews and the HTTP server, and write the database to disk. */
    async close() {
      clearInterval(sentryTimer);
      slackApp.stop();
      orch.stop();
      previews.stopAll();
      reports.stopSchedule();
      for (const c of wss.clients) c.terminate();
      wss.close();
      store.flush();
      if (started) await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
