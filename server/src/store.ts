import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DEFAULT_AGENTS, DEFAULT_SETTINGS } from './agents/defaults.js';
import type { AgentConfig, DB, LogEvent, Settings, Ticket } from './types.js';

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

  constructor(private file: string) {
    super();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = this.load();
  }

  private load(): DB {
    const fresh: DB = { seq: 0, tickets: [], agents: structuredClone(DEFAULT_AGENTS), settings: structuredClone(DEFAULT_SETTINGS), logs: [] };
    if (!fs.existsSync(this.file)) return fresh;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<DB>;
      return {
        seq: raw.seq ?? 0,
        tickets: raw.tickets ?? [],
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
        },
        logs: raw.logs ?? [],
      };
    } catch (err) {
      console.error('[store] could not read db, starting fresh:', err);
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

  nextKey(prefix = 'FAC') {
    this.db.seq += 1;
    return `${prefix}-${this.db.seq}`;
  }

  createTicket(input: Partial<Ticket> & { title: string }): Ticket {
    const now = Date.now();
    const t: Ticket = {
      id: randomUUID(),
      key: input.key ?? this.nextKey(),
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
    };
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
