import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DEFAULT_AGENTS, DEFAULT_PROJECT_ID, DEFAULT_SETTINGS } from './agents/defaults.js';
import type { AgentConfig, AttentionItem, DB, LogEvent, Project, Settings, Ticket } from './types.js';

const MAX_LOGS = 20_000;
const SECRET_FIELDS: Array<[keyof Settings['connectors'], string]> = [
  ['github', 'token'],
  ['linear', 'apiKey'],
  ['jira', 'token'],
];
export const MASK = '••••••••';

/** Tiny JSON-file store. Good enough for a single-PM factory; swap for SQLite/Postgres later. */
export class Store extends EventEmitter {
  private db: DB;
  private saveTimer: NodeJS.Timeout | null = null;

  /** Folder next to the db file for artifacts (screenshots) etc. */
  get dataDir() {
    return path.dirname(this.file);
  }

  constructor(private file: string) {
    super();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = this.load();
  }

  private load(): DB {
    const fresh: DB = { seq: 0, tickets: [], agents: structuredClone(DEFAULT_AGENTS), settings: structuredClone(DEFAULT_SETTINGS), logs: [], attention: [] };
    if (!fs.existsSync(this.file)) return fresh;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<DB>;
      const rs = (raw.settings ?? {}) as Partial<Settings>;
      // Single-repo installs become a "default" project on first load.
      const projects: Project[] = rs.projects?.length
        ? rs.projects.map((p) => ({ ...fresh.settings.projects[0], ...p }))
        : [{
            ...fresh.settings.projects[0],
            repoPath: rs.repoPath ?? '',
            baseBranch: rs.baseBranch ?? 'main',
            worktreesDir: rs.worktreesDir ?? '',
            mergeStrategy: rs.mergeStrategy ?? 'local-merge',
            githubRepo: rs.connectors?.github?.repo || undefined,
            harvestProjectId: rs.harvest?.projectId,
            harvestTaskId: rs.harvest?.taskId,
          }];
      const defaultProjectId = projects.some((p) => p.id === rs.defaultProjectId) ? rs.defaultProjectId! : projects[0].id;
      return {
        seq: raw.seq ?? 0,
        seqs: raw.seqs ?? {},
        tickets: (raw.tickets ?? []).map((t) => ({ ...t, projectId: t.projectId ?? defaultProjectId })),
        // merge so new default fields survive upgrades
        agents: DEFAULT_AGENTS.map((d) => ({ ...d, ...(raw.agents?.find((a) => a.role === d.role) ?? {}) })),
        settings: {
          ...fresh.settings,
          ...(raw.settings ?? {}),
          gates: { ...fresh.settings.gates, ...(raw.settings?.gates ?? {}) },
          connectors: {
            github: { ...fresh.settings.connectors.github, ...(raw.settings?.connectors?.github ?? {}) },
            linear: { ...fresh.settings.connectors.linear, ...(raw.settings?.connectors?.linear ?? {}) },
            jira: { ...fresh.settings.connectors.jira, ...(raw.settings?.connectors?.jira ?? {}) },
          },
          ciGate: { ...fresh.settings.ciGate, ...(raw.settings?.ciGate ?? {}) },
          watchdog: { ...fresh.settings.watchdog, ...(raw.settings?.watchdog ?? {}) },
          harvest: { ...fresh.settings.harvest, ...(raw.settings?.harvest ?? {}) },
          notifications: mergeNotifications(fresh.settings.notifications, rs.notifications),
          reports: { ...fresh.settings.reports, ...(rs.reports ?? {}) },
          scoper: { ...fresh.settings.scoper, ...(rs.scoper ?? {}) },
          quality: mergeQuality(fresh.settings.quality, rs.quality),
          forecast: { ...fresh.settings.forecast, ...(rs.forecast ?? {}) },
          projects,
          defaultProjectId,
        },
        logs: raw.logs ?? [],
        attention: raw.attention ?? [],
        game: raw.game,
        calibration: raw.calibration ?? {},
      };
    } catch (err) {
      // Never silently overwrite a file we couldn't read: keep a copy next to it first.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.file, backup);
      } catch {
        /* nothing to keep */
      }
      console.error(`[store] could not read ${this.file} (kept a copy at ${backup}); starting fresh:`, err);
      return fresh;
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 250);
  }

  flush() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // ---------- tickets ----------
  tickets() {
    return this.db.tickets;
  }

  ticket(id: string) {
    return this.db.tickets.find((t) => t.id === id);
  }

  // ---------- projects ----------
  projects() {
    return this.db.settings.projects;
  }

  /** A ticket's project (falls back to the default project). */
  project(id?: string): Project {
    const ps = this.db.settings.projects;
    return ps.find((p) => p.id === id) ?? ps.find((p) => p.id === this.db.settings.defaultProjectId) ?? ps[0];
  }

  nextKey(prefix = 'FAC') {
    // numbered per prefix, so each project counts from 1 — and a deleted ticket's key (and branch) is never reused
    const re = new RegExp(`^${prefix.replace(/[^A-Za-z0-9]/g, '')}-(\\d+)$`);
    const max = this.db.tickets.reduce((m, t) => Math.max(m, Number(t.key.match(re)?.[1] ?? 0)), 0);
    const seqs = (this.db.seqs ??= {});
    seqs[prefix] = Math.max(seqs[prefix] ?? 0, max) + 1;
    this.db.seq += 1;
    return `${prefix}-${seqs[prefix]}`;
  }

  createTicket(input: Partial<Ticket> & { title: string }): Ticket {
    const now = Date.now();
    const project = this.project(input.projectId);
    const t: Ticket = {
      id: randomUUID(),
      projectId: project.id,
      key: input.key ?? this.nextKey(project.keyPrefix || 'FAC'),
      title: input.title,
      description: input.description ?? '',
      source: input.source ?? 'local',
      externalId: input.externalId,
      externalUrl: input.externalUrl,
      priority: input.priority ?? 'medium',
      labels: input.labels ?? [],
      stage: input.stage ?? 'backlog',
      notes: [],
      iterations: 0,
      costUsd: 0,
      tokens: 0,
      createdAt: now,
      updatedAt: now,
      order: now,
    };
    this.db.tickets.push(t);
    this.scheduleSave();
    this.emit('ticket', t);
    return t;
  }

  updateTicket(id: string, patch: Partial<Ticket>): Ticket | undefined {
    const t = this.ticket(id);
    if (!t) return undefined;
    Object.assign(t, patch, { updatedAt: Date.now() });
    this.scheduleSave();
    this.emit('ticket', t);
    return t;
  }

  deleteTicket(id: string) {
    this.db.tickets = this.db.tickets.filter((t) => t.id !== id);
    this.db.logs = this.db.logs.filter((l) => l.ticketId !== id);
    for (const a of this.db.attention) if (a.ticketId === id && (a.status === 'open' || a.status === 'held')) a.status = 'dismissed';
    this.emit('attention', this.db.attention);
    this.scheduleSave();
    this.emit('ticketDeleted', id);
  }

  // ---------- logs ----------
  log(e: Omit<LogEvent, 'id' | 'ts'>): LogEvent {
    const ev: LogEvent = { ...e, id: randomUUID(), ts: Date.now() };
    this.db.logs.push(ev);
    if (this.db.logs.length > MAX_LOGS) this.db.logs.splice(0, this.db.logs.length - MAX_LOGS);
    this.scheduleSave();
    this.emit('log', ev);
    return ev;
  }

  logs(ticketId?: string, limit = 500) {
    const src = ticketId ? this.db.logs.filter((l) => l.ticketId === ticketId) : this.db.logs;
    return src.slice(-limit);
  }

  // ---------- attention (the PM's inbox) ----------
  attention() {
    return this.db.attention;
  }

  attentionItem(id: string) {
    return this.db.attention.find((a) => a.id === id);
  }

  /** Open items for a key (e.g. "merge:<ticket>"). */
  openAttention(key: string) {
    return this.db.attention.find((a) => a.key === key && (a.status === 'open' || a.status === 'held'));
  }

  /**
   * Post an item. Anything still open under the same key is superseded (dismissed),
   * so the PM only ever sees the latest version of a question.
   */
  postAttention(input: Omit<AttentionItem, 'id' | 'createdAt' | 'updatedAt' | 'status'> & { status?: AttentionItem['status'] }): AttentionItem {
    const now = Date.now();
    for (const a of this.db.attention) {
      if (a.key === input.key && (a.status === 'open' || a.status === 'held')) {
        a.status = 'dismissed';
        a.updatedAt = now;
      }
    }
    const item: AttentionItem = { ...input, id: randomUUID(), status: input.status ?? 'open', createdAt: now, updatedAt: now };
    this.db.attention.push(item);
    // keep history bounded
    const closed = this.db.attention.filter((a) => a.status === 'resolved' || a.status === 'dismissed');
    if (closed.length > 500) {
      const drop = new Set(closed.slice(0, closed.length - 500).map((a) => a.id));
      this.db.attention = this.db.attention.filter((a) => !drop.has(a.id));
    }
    this.scheduleSave();
    this.emit('attention', this.db.attention);
    return item;
  }

  updateAttention(id: string, patch: Partial<AttentionItem>) {
    const a = this.attentionItem(id);
    if (!a) return undefined;
    Object.assign(a, patch, { updatedAt: Date.now() });
    this.scheduleSave();
    this.emit('attention', this.db.attention);
    return a;
  }

  /** Close every open item for a ticket (it moved on without the PM). */
  closeAttentionFor(ticketId: string, keyPrefix?: string) {
    let changed = false;
    for (const a of this.db.attention) {
      if (a.ticketId === ticketId && (a.status === 'open' || a.status === 'held') && (!keyPrefix || a.key.startsWith(keyPrefix))) {
        a.status = 'dismissed';
        a.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) {
      this.scheduleSave();
      this.emit('attention', this.db.attention);
    }
  }

  // ---------- gamification ----------
  game() {
    return this.db.game;
  }

  setGame(g: NonNullable<DB['game']>) {
    this.db.game = g;
    this.scheduleSave();
  }

  // ---------- forecasts ----------
  calibration(projectId: string) {
    return this.db.calibration?.[projectId];
  }

  /** Learn from a finished ticket: how far off was the forecast? (rolling average, capped so one outlier can't swing it) */
  calibrate(projectId: string, estimated: { costUsd: number; minutes: number }, actual: { costUsd: number; minutes: number }) {
    if (estimated.costUsd <= 0 || estimated.minutes <= 0) return;
    const clamp = (x: number) => Math.min(4, Math.max(0.25, x));
    const cur = this.db.calibration?.[projectId] ?? { n: 0, costRatio: 1, timeRatio: 1 };
    const n = Math.min(cur.n + 1, 20);
    const next = {
      n: cur.n + 1,
      costRatio: +(cur.costRatio + (clamp(actual.costUsd / estimated.costUsd) - cur.costRatio) / n).toFixed(3),
      timeRatio: +(cur.timeRatio + (clamp(actual.minutes / estimated.minutes) - cur.timeRatio) / n).toFixed(3),
    };
    this.db.calibration = { ...(this.db.calibration ?? {}), [projectId]: next };
    this.scheduleSave();
    return next;
  }

  // ---------- agents ----------
  agents() {
    return this.db.agents;
  }

  agent(role: AgentConfig['role']) {
    return this.db.agents.find((a) => a.role === role)!;
  }

  updateAgent(role: AgentConfig['role'], patch: Partial<AgentConfig>) {
    const a = this.agent(role);
    Object.assign(a, patch, { role });
    this.scheduleSave();
    this.emit('agents', this.db.agents);
    return a;
  }

  resetAgent(role: AgentConfig['role']) {
    const d = DEFAULT_AGENTS.find((x) => x.role === role)!;
    return this.updateAgent(role, structuredClone(d));
  }

  // ---------- settings ----------
  settings() {
    return this.db.settings;
  }

  /** Settings for the browser, with secrets masked. */
  publicSettings(): Settings {
    const s = structuredClone(this.db.settings);
    for (const [c, f] of SECRET_FIELDS) {
      const conn = s.connectors[c] as unknown as Record<string, string>;
      if (conn[f]) conn[f] = MASK;
    }
    if (s.harvest.token) s.harvest.token = MASK;
    if (s.notifications.slack.webhookUrl) s.notifications.slack.webhookUrl = MASK;
    return s;
  }

  updateSettings(patch: Partial<Settings>) {
    const cur = this.db.settings;
    const next: Settings = {
      ...cur,
      ...patch,
      gates: { ...cur.gates, ...(patch.gates ?? {}) },
      connectors: {
        github: { ...cur.connectors.github, ...(patch.connectors?.github ?? {}) },
        linear: { ...cur.connectors.linear, ...(patch.connectors?.linear ?? {}) },
        jira: { ...cur.connectors.jira, ...(patch.connectors?.jira ?? {}) },
      },
      ciGate: { ...cur.ciGate, ...(patch.ciGate ?? {}) },
      watchdog: { ...cur.watchdog, ...(patch.watchdog ?? {}) },
      harvest: { ...cur.harvest, ...(patch.harvest ?? {}) },
      notifications: mergeNotifications(cur.notifications, patch.notifications),
      reports: { ...cur.reports, ...(patch.reports ?? {}) },
      scoper: { ...cur.scoper, ...(patch.scoper ?? {}) },
      quality: mergeQuality(cur.quality, patch.quality),
      forecast: { ...cur.forecast, ...(patch.forecast ?? {}) },
      projects: patch.projects?.length ? patch.projects : cur.projects,
    };
    if (next.harvest.token === MASK) next.harvest.token = cur.harvest.token;
    if (next.notifications.slack.webhookUrl === MASK) next.notifications.slack.webhookUrl = cur.notifications.slack.webhookUrl;
    if (!next.projects.some((p) => p.id === next.defaultProjectId)) next.defaultProjectId = next.projects[0].id;
    // tickets of a deleted project move to the default one
    for (const t of this.db.tickets) if (!next.projects.some((p) => p.id === t.projectId)) t.projectId = next.defaultProjectId;
    // a masked value coming back from the UI means "unchanged"
    for (const [c, f] of SECRET_FIELDS) {
      const n = next.connectors[c] as unknown as Record<string, string>;
      const o = cur.connectors[c] as unknown as Record<string, string>;
      if (n[f] === MASK) n[f] = o[f];
    }
    this.db.settings = next;
    this.scheduleSave();
    this.emit('settings', this.publicSettings());
    return next;
  }
}

function mergeNotifications(base: Settings['notifications'], patch?: Partial<Settings['notifications']>): Settings['notifications'] {
  return {
    ...base,
    ...(patch ?? {}),
    slack: { ...base.slack, ...(patch?.slack ?? {}) },
    events: { ...base.events, ...(patch?.events ?? {}) },
    quietHours: { ...base.quietHours, ...(patch?.quietHours ?? {}) },
  };
}

function mergeQuality(base: Settings['quality'], patch?: Partial<Settings['quality']>): Settings['quality'] {
  return { ...base, ...(patch ?? {}), coverage: { ...base.coverage, ...(patch?.coverage ?? {}) } };
}

export { DEFAULT_PROJECT_ID };
