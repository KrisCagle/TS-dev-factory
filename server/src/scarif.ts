import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Store } from './store.js';
import type { ScarifFleet, ScarifJobView, ScarifWorkerView, Ticket } from './types.js';

/**
 * Scarif: remote Claude Code workers ("droids") that take a Jira ticket and a repo and do the work.
 * The factory reads the fleet with your CLI token (~/.scarif/cli.json, written by `scarif setup`),
 * sends tickets with `scarif enqueue`, and tracks them on the board in the Remote column.
 * The token never reaches the browser or the logs.
 */

/** Statuses where a job is still alive. */
export const LIVE_STATUSES = ['in_progress', 'pending', 'queued', 'dependency_wait', 'paused', 'plan_approval', 'human_review', 'blocked'];
export const NEEDS_HUMAN = ['plan_approval', 'human_review', 'blocked'];
const DONE = ['completed', 'complete', 'done', 'succeeded', 'success', 'merged'];
const FAILED = ['failed', 'error', 'cancelled', 'canceled', 'abandoned'];

/** Write tools hidden from sessions unless you turn writes on (Scarif's MCP has no read-only mode). */
export const SCARIF_WRITE_TOOLS = [
  'add_jira_comment', 'cancel_work_item', 'create_jira_issue_link', 'delete_jira_issue_link', 'enqueue_work_item', 'link_thread',
  'pause_work_item', 'register_repo', 'release_work_item', 'send_droid_input', 'unlink_thread', 'unpause_work_item',
  'update_jira_issue', 'update_step', 'update_work_item', 'update_workflow', 'upload_screenshot',
];

export const JIRA_KEY = /^[A-Z][A-Z0-9]{1,15}-\d+$/;

export interface Credentials { url: string; token: string }

export function cliConfigFile() {
  return process.env.SCARIF_CLI_CONFIG || path.join(os.homedir(), '.scarif', 'cli.json');
}

export function readCredentials(s: { url: string; token: string }): Credentials | null {
  if (s.url && s.token) return { url: s.url.replace(/\/+$/, ''), token: s.token };
  try {
    const c = JSON.parse(fs.readFileSync(cliConfigFile(), 'utf8')) as { scarifUrl?: string; apiToken?: string };
    return c.scarifUrl && c.apiToken ? { url: c.scarifUrl.replace(/\/+$/, ''), token: c.apiToken } : null;
  } catch {
    return null;
  }
}

/** The `scarif` CLI, if installed (Homebrew paths too: a LaunchAgent's PATH lacks them). */
export function scarifBin(): string | null {
  const candidates = [
    process.env.FACTORY_SCARIF_BIN,
    ...(process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, 'scarif')),
    '/opt/homebrew/bin/scarif',
    '/usr/local/bin/scarif',
  ].filter(Boolean) as string[];
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) ?? null;
}

/** Scarif sends "2026-09-28 18:51:34 UTC" as well as ISO strings. */
export function parseTime(v?: string | null) {
  if (!v) return undefined;
  const ms = Date.parse(v.replace(/ UTC$/, 'Z').replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T'));
  return Number.isNaN(ms) ? undefined : ms;
}

interface RawItem {
  id: string; display_key?: string | null; jira_key?: string | null; jira_summary?: string | null; status?: string | null; updated_at?: string | null;
  enqueued_by?: { id?: string | number | null } | null;
  repositories?: Array<{ name?: string | null; full_name?: string | null }> | null;
  current_stage?: { stage_type?: string | null; worker_session_id?: string | null; worker_name?: string | null } | null;
  pull_request_url?: string | null;
}
interface RawWorker {
  id: string; name: string; status: string; healthy?: boolean | null; last_heartbeat_at?: string | null;
  host?: { load_average_1m?: number | null; cpu_count?: number | null } | null; disk?: { used_percent?: number | null } | null; quiet?: unknown;
}

const listOf = <T>(raw: unknown, key: string): T[] => (Array.isArray(raw) ? raw : ((raw as Record<string, unknown>)?.[key] as T[]) ?? (raw as { data?: T[] })?.data ?? []);

export function jobView(i: RawItem, url: string): ScarifJobView {
  return {
    workItemId: i.id,
    key: i.display_key || i.jira_key || i.id.slice(0, 8),
    jiraKey: i.jira_key ?? undefined,
    summary: i.jira_summary ?? undefined,
    status: i.status ?? 'unknown',
    stage: i.current_stage?.stage_type ?? undefined,
    needsHuman: NEEDS_HUMAN.includes(i.status ?? ''),
    url: `${url}/work_items/${encodeURIComponent(i.id)}`,
    repos: (i.repositories ?? []).map((r) => r.name).filter(Boolean) as string[],
    updatedAt: parseTime(i.updated_at),
  };
}

/** Your jobs grouped under the workers running them; jobs nobody has picked up yet go in `queued`. */
export function groupFleet(items: RawItem[], workers: RawWorker[], me: string | undefined, url: string, also: Set<string>) {
  const mine = items.filter((i) => (me && String(i.enqueued_by?.id ?? '') === me) || also.has(i.jira_key ?? '') || also.has(i.id));
  const byWorker = new Map<string, ScarifJobView[]>();
  const queued: ScarifJobView[] = [];
  for (const i of mine) {
    const k = i.current_stage?.worker_session_id || (i.current_stage?.worker_name ? `name:${i.current_stage.worker_name}` : '');
    if (!k) queued.push(jobView(i, url));
    else byWorker.set(k, [...(byWorker.get(k) ?? []), jobView(i, url)]);
  }
  const views: ScarifWorkerView[] = [];
  for (const w of workers) {
    const jobs = byWorker.get(w.id) ?? byWorker.get(`name:${w.name}`);
    if (!jobs?.length) continue;
    byWorker.delete(w.id);
    byWorker.delete(`name:${w.name}`);
    views.push({
      id: w.id, name: w.name, status: w.quiet ? 'quiet' : w.status, healthy: w.healthy ?? undefined, lastHeartbeatAt: parseTime(w.last_heartbeat_at),
      load: w.host?.load_average_1m ?? undefined, cpus: w.host?.cpu_count ?? undefined, diskPct: w.disk?.used_percent ?? undefined, jobs,
    });
  }
  for (const [k, jobs] of byWorker) views.push({ id: k, name: k.replace(/^name:/, ''), status: 'unknown', jobs });
  return { workers: views, queued };
}

export function outcome(status: string): 'done' | 'failed' | 'needs-you' | 'running' {
  const s = status.toLowerCase();
  if (DONE.includes(s)) return 'done';
  if (FAILED.includes(s)) return 'failed';
  if (NEEDS_HUMAN.includes(s)) return 'needs-you';
  return 'running';
}

export class Scarif {
  fleet: ScarifFleet = { state: 'off', at: 0, workers: [], queued: [], cliInstalled: false };
  private timer: NodeJS.Timeout | null = null;
  private me?: { key: string; id: string };
  /** Simulated mode: fake progress per ticket. */
  private sim = new Map<string, number>();

  constructor(
    private store: Store,
    private onChange: (f: ScarifFleet) => void,
    private opts: { speed?: number; fetch?: typeof fetch; exec?: (bin: string, args: string[]) => Promise<string> } = {},
  ) {}

  private get fetch() {
    return this.opts.fetch ?? fetch;
  }

  start() {
    const tick = () => {
      void this.refresh().finally(() => {
        const s = this.store.settings();
        const every = s.mode === 'mock' ? 5000 * (this.opts.speed ?? 1) : this.store.tickets().some((t) => t.stage === 'remote') ? 60_000 : 5 * 60_000;
        this.timer = setTimeout(tick, Math.max(50, every));
        this.timer.unref?.();
      });
    };
    tick();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async get<T>(c: Credentials, p: string): Promise<T> {
    const r = await this.fetch(c.url + p, { headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 401 || r.status === 403) throw new Error(`Scarif refused the token (HTTP ${r.status}) — re-run \`scarif setup\``);
    if (!r.ok) throw new Error(`Scarif answered HTTP ${r.status} for ${p.split('?')[0]}`);
    return (await r.json()) as T;
  }

  /** Read the fleet and move remote tickets along. */
  async refresh(): Promise<ScarifFleet> {
    const s = this.store.settings();
    const cliInstalled = !!scarifBin();
    if (s.mode === 'mock') return this.publish(this.simulate(cliInstalled));
    if (!s.scarif.enabled) return this.publish({ state: 'off', at: Date.now(), workers: [], queued: [], cliInstalled });
    const c = readCredentials(s.scarif);
    if (!c) return this.publish({ state: 'unconfigured', at: Date.now(), workers: [], queued: [], cliInstalled });
    try {
      const me = await this.whoAmI(c);
      const [items, workers] = await Promise.all([
        this.get<unknown>(c, `/api/v2/work_items?status=${LIVE_STATUSES.join(',')}&limit=100`),
        this.get<unknown>(c, '/api/v2/worker_sessions'),
      ]);
      const raw = listOf<RawItem>(items, 'work_items');
      const remote = this.store.tickets().filter((t) => t.stage === 'remote' && t.remote);
      const also = new Set(remote.flatMap((t) => [t.remote!.key, t.remote!.workItemId ?? '']));
      const g = groupFleet(raw, listOf<RawWorker>(workers, 'worker_sessions'), me, c.url, also);
      // tickets whose job left the live list finished one way or the other: look each one up
      for (const t of remote) {
        const live = raw.find((i) => i.id === t.remote!.workItemId || i.jira_key === t.remote!.key);
        if (live) this.track(t, jobView(live, c.url), live.current_stage?.worker_name ?? undefined);
        else if (t.remote!.workItemId) {
          const one = await this.get<RawItem | { work_item: RawItem }>(c, `/api/v2/work_items/${encodeURIComponent(t.remote!.workItemId)}`).catch(() => undefined);
          const item = one && ('work_item' in one ? one.work_item : one);
          if (item?.id) this.track(t, jobView(item, c.url), undefined, item.pull_request_url ?? undefined);
        }
      }
      return this.publish({ state: 'ready', at: Date.now(), url: c.url, ...g, cliInstalled });
    } catch (e) {
      return this.publish({ state: 'error', error: e instanceof Error ? e.message : String(e), at: Date.now(), url: c.url, workers: [], queued: [], cliInstalled });
    }
  }

  private async whoAmI(c: Credentials) {
    const key = `${c.url}\n${c.token}`;
    if (this.me?.key === key) return this.me.id;
    const r = await this.get<{ user?: { id?: string | number } }>(c, '/api/v2/me').catch(() => ({ user: undefined }));
    const id = r.user?.id !== undefined ? String(r.user.id) : '';
    this.me = { key, id };
    return id || undefined;
  }

  private publish(f: ScarifFleet) {
    this.fleet = f;
    this.onChange(f);
    return f;
  }

  /** Apply a job's status to its ticket. */
  private track(t: Ticket, job: ScarifJobView, worker?: string, prUrl?: string) {
    const r = t.remote!;
    if (r.status !== job.status || r.worker !== worker) {
      this.store.updateTicket(t.id, { remote: { ...r, status: job.status, url: job.url, workItemId: job.workItemId, worker: worker ?? r.worker, updatedAt: Date.now() } });
      this.store.log({ ticketId: t.id, agent: 'factory', kind: 'status', text: `🛰 Scarif: ${job.status.replace(/_/g, ' ')}${worker ? ` on ${worker}` : ''}` });
    }
    const o = outcome(job.status);
    const key = `scarif:${job.workItemId}`;
    if (o === 'needs-you' && !this.store.openAttention(key)) {
      this.store.postAttention({
        kind: 'todo', key, ticketId: t.id, projectId: t.projectId, origin: 'scarif', url: job.url,
        title: `Scarif needs you on ${t.key}: ${job.status.replace(/_/g, ' ')}`,
        body: `The droid working ${t.key} is waiting on a person (${job.status.replace(/_/g, ' ')}). Open it in Scarif to answer.`,
        options: [{ id: 'done', label: 'Handled it', primary: true }],
      });
    } else if (o !== 'needs-you') {
      const open = this.store.openAttention(key);
      if (open) this.store.updateAttention(open.id, { status: 'dismissed' });
    }
    if (o === 'done') {
      this.store.updateTicket(t.id, { stage: 'done', finishedAt: Date.now(), ...(prUrl ? { prUrl } : {}) });
      this.store.log({ ticketId: t.id, agent: 'factory', kind: 'result', text: '🛰 Scarif finished this ticket.' });
    } else if (o === 'failed') {
      this.store.updateTicket(t.id, { stage: 'failed', error: `Scarif: ${job.status}` });
    }
  }

  /** Send a ticket to Scarif. It needs a Jira key and the project's GitHub repo. */
  async enqueue(ticketId: string) {
    const t = this.store.ticket(ticketId);
    if (!t) throw Object.assign(new Error('Ticket not found'), { status: 404 });
    if (['planning', 'coding', 'testing', 'reviewing', 'remote'].includes(t.stage)) throw Object.assign(new Error(`${t.key} is already being worked.`), { status: 409 });
    const s = this.store.settings();
    const jiraKey = JIRA_KEY.test(t.externalId ?? '') ? t.externalId! : JIRA_KEY.test(t.key) && t.source === 'jira' ? t.key : undefined;
    const repo = this.store.project(t.projectId).githubRepo || s.connectors.github.repo;
    const now = Date.now();
    if (s.mode === 'mock') {
      const key = jiraKey ?? t.key;
      this.sim.set(t.id, 0);
      this.store.updateTicket(t.id, { stage: 'remote', startedAt: now, remote: { kind: 'scarif', key, workItemId: `sim-${t.id.slice(0, 8)}`, status: 'queued', since: now, updatedAt: now } });
      this.store.log({ ticketId: t.id, agent: 'factory', kind: 'status', text: `🛰 Sent ${key} to Scarif (simulated).` });
      return this.store.ticket(t.id);
    }
    if (!s.scarif.enabled) throw Object.assign(new Error('Turn Scarif on in Settings → Integrations first.'), { status: 400 });
    if (!jiraKey) throw Object.assign(new Error(`Scarif works from Jira tickets — ${t.key} has no Jira key.`), { status: 400 });
    if (!repo) throw Object.assign(new Error('Set the project’s GitHub repo (owner/repo) first.'), { status: 400 });
    const bin = scarifBin();
    if (!bin) throw Object.assign(new Error('The scarif CLI isn’t installed (see the README’s Scarif section).'), { status: 400 });
    const out = await (this.opts.exec ?? runCli)(bin, ['enqueue', jiraKey, '--repo', repo]);
    const workItemId = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    this.store.updateTicket(t.id, { stage: 'remote', startedAt: now, remote: { kind: 'scarif', key: jiraKey, workItemId, status: 'queued', since: now, updatedAt: now } });
    this.store.log({ ticketId: t.id, agent: 'factory', kind: 'status', text: `🛰 Sent ${jiraKey} to Scarif (${repo}).` });
    void this.refresh();
    return this.store.ticket(t.id);
  }

  /** Stop tracking a remote ticket (it goes back to Ready to run locally). */
  recall(ticketId: string) {
    const t = this.store.ticket(ticketId);
    if (!t || t.stage !== 'remote') throw Object.assign(new Error('That ticket isn’t on Scarif.'), { status: 409 });
    this.sim.delete(t.id);
    this.store.updateTicket(t.id, { stage: 'ready', remote: undefined });
    this.store.log({ ticketId: t.id, agent: 'factory', kind: 'status', text: 'Brought back from Scarif to run locally. (Cancel the job in Scarif if it is still running.)' });
    return this.store.ticket(t.id);
  }

  /** Scarif's MCP tools for sessions, read-only unless writes are on. */
  sessionTools(): { mcpServers: Record<string, McpServerConfig>; disallowedTools: string[] } {
    const s = this.store.settings().scarif;
    const bin = s.enabled && s.sessionTools ? scarifBin() : null;
    if (!bin) return { mcpServers: {}, disallowedTools: [] };
    let script = bin;
    try { script = fs.realpathSync(bin); } catch { /* keep */ }
    const isNodeScript = /\.(m?js|cjs)$/.test(script) || head(script).includes('node');
    return {
      mcpServers: { scarif: isNodeScript ? { type: 'stdio', command: process.execPath, args: [script, 'mcp'] } : { type: 'stdio', command: bin, args: ['mcp'] } },
      disallowedTools: s.allowWrites ? [] : SCARIF_WRITE_TOOLS.map((x) => `mcp__scarif__${x}`),
    };
  }

  /** Simulated fleet: two droids that work through remote tickets. */
  private simulate(cliInstalled: boolean): ScarifFleet {
    const remote = this.store.tickets().filter((t) => t.stage === 'remote' && t.remote);
    const steps = ['queued', 'in_progress', 'in_progress', 'human_review', 'completed'];
    const jobs: Array<{ job: ScarifJobView; worker: string }> = [];
    remote.forEach((t, i) => {
      const n = (this.sim.get(t.id) ?? 0) + 1;
      this.sim.set(t.id, n);
      const status = steps[Math.min(n, steps.length - 1)];
      const worker = status === 'queued' ? '' : `droid-${(i % 2) + 1}`;
      const job: ScarifJobView = { workItemId: t.remote!.workItemId ?? t.id, key: t.remote!.key, jiraKey: t.remote!.key, summary: t.title, status, stage: status === 'in_progress' ? 'implement' : undefined, needsHuman: NEEDS_HUMAN.includes(status), url: '#', repos: [], updatedAt: Date.now() };
      this.track(t, job, worker || undefined);
      if (outcome(job.status) !== 'done') jobs.push({ job, worker });
    });
    const workers: ScarifWorkerView[] = ['droid-1', 'droid-2'].map((name) => ({
      id: name, name, status: jobs.some((j) => j.worker === name) ? 'busy' : 'idle', healthy: true, lastHeartbeatAt: Date.now(), load: 1.2, cpus: 8, diskPct: 41,
      jobs: jobs.filter((j) => j.worker === name).map((j) => j.job),
    }));
    return { state: 'ready', at: Date.now(), url: 'simulated', workers, queued: jobs.filter((j) => !j.worker).map((j) => j.job), cliInstalled };
  }
}

function head(file: string) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64);
    fs.readSync(fd, buf, 0, 64, 0);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function runCli(bin: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const env = { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin` };
    execFile(bin, args, { env, timeout: 120_000 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().slice(0, 500))) : resolve(`${stdout}\n${stderr}`)));
  });
}
