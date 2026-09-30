import { harvest, harvestConfigured, type HarvestEntry } from './connectors/harvest.js';
import type { Store } from './store.js';
import type { Ticket } from './types.js';

export interface HarvestStatus {
  configured: boolean;
  todayHours: number;
  entries: Array<{ id: number; hours: number; notes: string | null; project: string; task: string; running: boolean }>;
  running?: { entryId: number; notes: string | null; hours: number; ticketId?: string };
  error?: string;
  checkedAt: number;
}

/**
 * Time tracking for the PM. The factory's agents aren't billable people —
 * what gets tracked is *your* time reviewing, deciding and signing off.
 */
export class HarvestService {
  private cache: HarvestStatus | null = null;

  constructor(private store: Store) {}

  configured() {
    return harvestConfigured(this.store.settings());
  }

  /** The Harvest project/task a ticket's time goes to (ticket override, else the default). */
  target(t: Ticket) {
    const s = this.store.settings().harvest;
    const projectId = t.harvest?.projectId ?? s.projectId;
    const taskId = t.harvest?.taskId ?? s.taskId;
    if (!projectId || !taskId) throw new Error('Pick a Harvest project and task in Settings (or on the ticket) first.');
    return { projectId, taskId };
  }

  private ticketHarvest(t: Ticket) {
    return t.harvest ?? { loggedHours: 0 };
  }

  async startTimer(ticketId: string, reason = 'PM review') {
    const s = this.store.settings();
    if (!this.configured()) throw new Error('Harvest isn’t connected — add your token and account id in Settings.');
    const t = this.store.ticket(ticketId);
    if (!t) throw new Error('Ticket not found');
    if (t.harvest?.timer) return t.harvest.timer;
    const { projectId, taskId } = this.target(t);
    const notes = `${t.key}: ${t.title} — ${reason}`;
    const entry = await harvest.startTimer(s, projectId, taskId, notes);
    const timer = { entryId: entry.id, startedAt: Date.now(), notes };
    this.store.updateTicket(t.id, { harvest: { ...this.ticketHarvest(t), timer } });
    this.store.log({ ticketId: t.id, agent: 'pm', kind: 'pm', text: `⏱ Harvest timer started (${reason})` });
    this.invalidate();
    return timer;
  }

  async stopTimer(ticketId: string) {
    const t = this.store.ticket(ticketId);
    const timer = t?.harvest?.timer;
    if (!t || !timer) return undefined;
    let hours = 0;
    try {
      const entry = await harvest.stopTimer(this.store.settings(), timer.entryId);
      hours = entry.hours;
    } catch (err) {
      // already stopped in Harvest itself — just forget it locally
      this.store.log({ ticketId: t.id, agent: 'factory', kind: 'error', text: `Harvest stop: ${(err as Error).message}` });
    }
    const h = this.ticketHarvest(t);
    this.store.updateTicket(t.id, { harvest: { ...h, timer: undefined, loggedHours: +(h.loggedHours + hours).toFixed(2) } });
    if (hours) this.store.log({ ticketId: t.id, agent: 'pm', kind: 'pm', text: `⏱ Logged ${hours.toFixed(2)} h to Harvest` });
    this.invalidate();
    return hours;
  }

  /** Stop quietly if a timer is running — used when a decision is made. */
  async stopIfRunning(ticketId: string) {
    if (this.store.ticket(ticketId)?.harvest?.timer) await this.stopTimer(ticketId).catch(() => undefined);
  }

  async logTime(ticketId: string, hours: number, notes?: string) {
    const s = this.store.settings();
    if (!this.configured()) throw new Error('Harvest isn’t connected — add your token and account id in Settings.');
    if (!(hours > 0 && hours <= 24)) throw new Error('Hours must be between 0 and 24.');
    const t = this.store.ticket(ticketId);
    if (!t) throw new Error('Ticket not found');
    const { projectId, taskId } = this.target(t);
    await harvest.logHours(s, projectId, taskId, hours, notes?.trim() || `${t.key}: ${t.title}`);
    const h = this.ticketHarvest(t);
    this.store.updateTicket(t.id, { harvest: { ...h, loggedHours: +(h.loggedHours + hours).toFixed(2) } });
    this.store.log({ ticketId: t.id, agent: 'pm', kind: 'pm', text: `⏱ Logged ${hours} h to Harvest` });
    this.invalidate();
  }

  invalidate() {
    this.cache = null;
  }

  async status(force = false): Promise<HarvestStatus> {
    if (!this.configured()) return { configured: false, todayHours: 0, entries: [], checkedAt: Date.now() };
    if (!force && this.cache && Date.now() - this.cache.checkedAt < 30_000) return this.cache;
    try {
      const entries = await harvest.todayEntries(this.store.settings());
      const run = entries.find((e) => e.is_running);
      const byEntry = new Map(this.store.tickets().filter((t) => t.harvest?.timer).map((t) => [t.harvest!.timer!.entryId, t.id]));
      this.cache = {
        configured: true,
        todayHours: +entries.reduce((a, e) => a + e.hours, 0).toFixed(2),
        entries: entries.map((e: HarvestEntry) => ({ id: e.id, hours: e.hours, notes: e.notes, project: e.project.name, task: e.task.name, running: e.is_running })),
        running: run ? { entryId: run.id, notes: run.notes, hours: run.hours, ticketId: byEntry.get(run.id) } : undefined,
        checkedAt: Date.now(),
      };
    } catch (err) {
      this.cache = { configured: true, todayHours: 0, entries: [], error: (err as Error).message, checkedAt: Date.now() };
    }
    return this.cache;
  }
}
