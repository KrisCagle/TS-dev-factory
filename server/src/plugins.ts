import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Store } from './store.js';
import type { Priority, Stage, Ticket } from './types.js';

/**
 * Factory plugins: small JavaScript modules that add an agent role, a quality gate,
 * a ticket source, an office room, or react to events. They live in the `plugins/`
 * folder (or FACTORY_PLUGINS_DIR) and run inside the factory with full access to your
 * machine — only install plugins you trust or wrote yourself.
 *
 *   // plugins/my-plugin.mjs
 *   export default {
 *     name: 'my-plugin',
 *     setup(api) { api.addGate({ id: 'no-todo', name: 'No TODOs', check: (t) => ({ ok: !/^\+.*TODO/m.test(t.diff ?? '') }) }); },
 *   };
 */

export interface PluginTicketView {
  id: string;
  key: string;
  title: string;
  description: string;
  stage: Stage;
  labels: string[];
  diff?: string;
  plan?: Ticket['plan'];
  testReport?: Ticket['testReport'];
  projectId: string;
}

export interface RoleResult {
  passed: boolean;
  summary: string;
  findings?: Array<{ file?: string; line?: number; severity?: 'blocker' | 'major' | 'minor' | 'nit'; comment: string }>;
}

export interface PluginRole {
  id: string;
  name: string;
  icon?: string;
  /** Runs after this step, once the built-in agents are happy. */
  after: 'tester' | 'reviewer';
  /** Instructions for this agent, given the ticket and its diff. */
  prompt: (t: PluginTicketView) => string;
  model?: string;
  tools?: string[];
  /** What the simulated agent reports (simulated mode). Defaults to "no issues". */
  mock?: (t: PluginTicketView) => RoleResult;
}

export interface PluginGate {
  id: string;
  name: string;
  check: (t: PluginTicketView) => { ok: boolean; message?: string } | Promise<{ ok: boolean; message?: string }>;
  /** 'sendback' returns the change to the Coder; 'flag' only lowers the safety score and shows in your review. */
  onFail?: 'sendback' | 'flag';
}

export interface ImportedItem {
  externalId: string;
  title: string;
  description?: string;
  priority?: Priority;
  labels?: string[];
  externalUrl?: string;
}

export interface PluginSource {
  id: string;
  label: string;
  pull: () => Promise<ImportedItem[]> | ImportedItem[];
}

export interface PluginRoom {
  id: string;
  label: string;
  icon?: string;
}

export type PluginEvent = 'ticketCreated' | 'stageChanged' | 'shipped';

export interface PluginApi {
  /** Your plugin's settings from Settings → Plugins (free-form JSON). */
  config: Record<string, unknown>;
  on(event: PluginEvent, fn: (t: PluginTicketView, extra: { from?: Stage }) => void | Promise<void>): void;
  addRole(role: PluginRole): void;
  addGate(gate: PluginGate): void;
  addSource(source: PluginSource): void;
  addRoom(room: PluginRoom): void;
  addNote(ticketId: string, text: string): void;
  log(ticketId: string, text: string): void;
}

export interface FactoryPlugin {
  name: string;
  description?: string;
  setup(api: PluginApi): void | Promise<void>;
}

export interface LoadedPlugin {
  name: string;
  file: string;
  description?: string;
  enabled: boolean;
  error?: string;
  roles: string[];
  gates: string[];
  sources: string[];
  rooms: string[];
}

interface Reg<T> { plugin: string; item: T }

export const view = (t: Ticket): PluginTicketView => ({
  id: t.id, key: t.key, title: t.title, description: t.description, stage: t.stage, labels: t.labels,
  diff: t.diff, plan: t.plan, testReport: t.testReport, projectId: t.projectId,
});

export class Plugins {
  loaded: LoadedPlugin[] = [];
  private roles: Reg<PluginRole>[] = [];
  private gates: Reg<PluginGate>[] = [];
  private sources: Reg<PluginSource>[] = [];
  private rooms: Reg<PluginRoom>[] = [];
  private handlers: Array<Reg<{ event: PluginEvent; fn: (t: PluginTicketView, extra: { from?: Stage }) => void | Promise<void> }>> = [];
  private stages = new Map<string, Stage>();

  constructor(
    private store: Store,
    public dir: string,
    /** How plugin files are loaded (overridable for test runners with their own module system). */
    private importer: (file: string) => Promise<Record<string, unknown>> = (file) => import(pathToFileURL(file).href),
  ) {
    for (const t of store.tickets()) this.stages.set(t.id, t.stage);
    store.on('ticket', (t: Ticket) => {
      const prev = this.stages.get(t.id);
      this.stages.set(t.id, t.stage);
      if (prev === undefined) this.fire('ticketCreated', t, {});
      else if (prev !== t.stage) {
        this.fire('stageChanged', t, { from: prev });
        if (t.stage === 'done') this.fire('shipped', t, { from: prev });
      }
    });
  }

  private enabled(name: string) {
    return this.store.settings().plugins?.[name]?.enabled !== false;
  }

  /** Load every .js / .mjs file at the top level of the plugins folder (examples/ is not loaded). */
  async load(files?: string[]) {
    const list = files ?? (fs.existsSync(this.dir) ? fs.readdirSync(this.dir).filter((f) => /\.(m?js)$/.test(f)).map((f) => path.join(this.dir, f)) : []);
    for (const file of list) {
      const rec: LoadedPlugin = { name: path.basename(file).replace(/\.m?js$/, ''), file, enabled: true, roles: [], gates: [], sources: [], rooms: [] };
      try {
        const mod = await this.importer(file);
        const p = (mod.default ?? mod.plugin) as FactoryPlugin | undefined;
        if (!p || typeof p.setup !== 'function' || !p.name) throw new Error('A plugin must export default { name, setup(api) }');
        rec.name = p.name;
        rec.description = p.description;
        if (this.loaded.some((x) => x.name === p.name)) throw new Error(`Another plugin is already called “${p.name}”`);
        await p.setup(this.api(p.name, rec));
      } catch (e) {
        rec.error = e instanceof Error ? e.message : String(e);
        console.error(`[plugins] ${file}: ${rec.error}`);
      }
      this.loaded.push(rec);
    }
    this.refreshEnabled();
    return this.loaded;
  }

  /** Register a plugin object directly (used by tests and built-ins). */
  async register(p: FactoryPlugin) {
    const rec: LoadedPlugin = { name: p.name, file: '(built-in)', description: p.description, enabled: true, roles: [], gates: [], sources: [], rooms: [] };
    await p.setup(this.api(p.name, rec));
    this.loaded.push(rec);
    this.refreshEnabled();
    return rec;
  }

  refreshEnabled() {
    for (const p of this.loaded) p.enabled = !p.error && this.enabled(p.name);
  }

  private api(plugin: string, rec: LoadedPlugin): PluginApi {
    const needId = (x: { id?: string }, what: string) => {
      if (!x?.id || !/^[a-z0-9][a-z0-9-]*$/.test(x.id)) throw new Error(`${what} needs an id made of lowercase letters, digits and dashes`);
    };
    return {
      config: (this.store.settings().plugins?.[plugin]?.config ?? {}) as Record<string, unknown>,
      on: (event, fn) => void this.handlers.push({ plugin, item: { event, fn } }),
      addRole: (role) => {
        needId(role, 'A role');
        if (!['tester', 'reviewer'].includes(role.after)) throw new Error('A role runs after "tester" or "reviewer"');
        if (typeof role.prompt !== 'function') throw new Error('A role needs a prompt(ticket) function');
        this.roles.push({ plugin, item: role });
        rec.roles.push(role.name);
      },
      addGate: (gate) => {
        needId(gate, 'A gate');
        if (typeof gate.check !== 'function') throw new Error('A gate needs a check(ticket) function');
        this.gates.push({ plugin, item: gate });
        rec.gates.push(gate.name);
      },
      addSource: (source) => {
        needId(source, 'A source');
        this.sources.push({ plugin, item: source });
        rec.sources.push(source.label);
      },
      addRoom: (room) => {
        needId(room, 'A room');
        this.rooms.push({ plugin, item: room });
        rec.rooms.push(room.label);
      },
      addNote: (ticketId, text) => {
        const t = this.store.ticket(ticketId);
        if (t) this.store.updateTicket(ticketId, { notes: [...t.notes, { id: `${plugin}-${Date.now()}`, text: `[${plugin}] ${text}`, ts: Date.now() }] });
      },
      log: (ticketId, text) => void this.store.log({ ticketId, agent: 'factory', kind: 'status', text: `🔌 ${plugin}: ${text}` }),
    };
  }

  private on<T>(regs: Reg<T>[]) {
    return regs.filter((r) => this.enabled(r.plugin) && !this.loaded.find((p) => p.name === r.plugin)?.error).map((r) => ({ ...r.item, plugin: r.plugin }));
  }

  rolesAfter(step: 'tester' | 'reviewer') {
    return this.on(this.roles).filter((r) => r.after === step);
  }

  activeGates() {
    return this.on(this.gates);
  }

  activeSources() {
    return this.on(this.sources);
  }

  activeRooms() {
    return this.on(this.rooms);
  }

  source(id: string) {
    return this.activeSources().find((s) => s.id === id);
  }

  private fire(event: PluginEvent, t: Ticket, extra: { from?: Stage }) {
    for (const h of this.on(this.handlers)) {
      if (h.event !== event) continue;
      Promise.resolve()
        .then(() => h.fn(view(t), extra))
        .catch((e) => this.store.log({ ticketId: t.id, agent: 'factory', kind: 'error', text: `🔌 ${h.plugin} (${event}) failed: ${e instanceof Error ? e.message : e}` }));
    }
  }

  summary() {
    return {
      dir: this.dir,
      plugins: this.loaded,
      rooms: this.activeRooms().map(({ id, label, icon, plugin }) => ({ id, label, icon, plugin })),
      sources: this.activeSources().map(({ id, label, plugin }) => ({ id, label, plugin })),
    };
  }
}
