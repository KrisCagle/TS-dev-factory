import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mergeProfile } from './profile.js';
import type { Lead, LeadProfile, LeadsDB, ScoutRun } from './types.js';

const MAX_RUNS = 50;
const MAX_SEEN = 20_000;

/**
 * Leads and the lead profile live in their own files next to the factory's db.json.
 * The data folder is gitignored, so prospects and your sales playbook stay on your machine.
 */
export class LeadStore extends EventEmitter {
  private db: LeadsDB;
  private prof: LeadProfile;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly dbFile: string;
  private readonly profileFile: string;

  constructor(dataDir: string) {
    super();
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbFile = path.join(dataDir, 'leads.json');
    this.profileFile = path.join(dataDir, 'lead-profile.json');
    this.db = readJson<LeadsDB>(this.dbFile) ?? { leads: [], runs: [], seen: {} };
    this.db.leads ??= [];
    this.db.runs ??= [];
    this.db.seen ??= {};
    this.prof = mergeProfile(readJson<Partial<LeadProfile>>(this.profileFile));
  }

  // ---------- profile ----------
  profile() {
    return this.prof;
  }

  updateProfile(patch: Partial<LeadProfile>) {
    this.prof = mergeProfile({ ...this.prof, ...patch });
    writeAtomic(this.profileFile, this.prof);
    this.emit('profile', this.prof);
    return this.prof;
  }

  // ---------- leads ----------
  leads() {
    return this.db.leads;
  }

  lead(id: string) {
    return this.db.leads.find((l) => l.id === id);
  }

  hasSeen(key: string) {
    return key in this.db.seen;
  }

  markSeen(key: string) {
    this.db.seen[key] = Date.now();
    const keys = Object.keys(this.db.seen);
    if (keys.length > MAX_SEEN) {
      // forget the oldest ones
      keys.sort((a, b) => this.db.seen[a] - this.db.seen[b]).slice(0, keys.length - MAX_SEEN).forEach((k) => delete this.db.seen[k]);
    }
    this.scheduleSave();
  }

  addLead(input: Omit<Lead, 'id' | 'status' | 'notes' | 'foundAt' | 'updatedAt'>): Lead {
    const now = Date.now();
    const lead: Lead = { ...input, id: randomUUID(), status: 'new', notes: [], foundAt: now, updatedAt: now };
    this.db.leads.push(lead);
    this.markSeen(lead.dedupeKey);
    this.scheduleSave();
    this.emit('lead', lead);
    return lead;
  }

  updateLead(id: string, patch: Partial<Lead>) {
    const l = this.lead(id);
    if (!l) return undefined;
    Object.assign(l, patch, { id: l.id, updatedAt: Date.now() });
    this.scheduleSave();
    this.emit('lead', l);
    return l;
  }

  addNote(id: string, text: string) {
    const l = this.lead(id);
    if (!l) return undefined;
    return this.updateLead(id, { notes: [...l.notes, { id: randomUUID(), text, ts: Date.now() }] });
  }

  deleteLead(id: string) {
    this.db.leads = this.db.leads.filter((l) => l.id !== id);
    this.scheduleSave();
    this.emit('leadDeleted', id);
  }

  // ---------- runs ----------
  runs() {
    return this.db.runs;
  }

  saveRun(run: ScoutRun) {
    const i = this.db.runs.findIndex((r) => r.id === run.id);
    if (i >= 0) this.db.runs[i] = run;
    else this.db.runs.push(run);
    if (this.db.runs.length > MAX_RUNS) this.db.runs.splice(0, this.db.runs.length - MAX_RUNS);
    this.scheduleSave();
    this.emit('run', run);
  }

  // ---------- persistence ----------
  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 250);
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    writeAtomic(this.dbFile, this.db);
  }
}

function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(file, backup);
    } catch {
      /* nothing to keep */
    }
    console.error(`[leads] could not read ${file} (kept a copy at ${backup}); starting fresh:`, err);
    return undefined;
  }
}

function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
