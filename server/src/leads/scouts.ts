import { randomUUID } from 'node:crypto';
import type { Store } from '../store.js';
import type { AttentionItem, Ticket } from '../types.js';
import { ClaudeClassifier, heuristicClassifier, prefilter, scoreLead, shorten, type Classifier } from './classifier.js';
import { SOURCES, defaultFetchJson, type FetchJson, type LeadSource } from './sources.js';
import type { LeadStore } from './store.js';
import type { Lead, LeadStatus, RawItem, ScoutRun } from './types.js';

export interface ScoutOptions {
  sources?: LeadSource[];
  fetchJson?: FetchJson;
  /** Force a classifier (tests). Otherwise: Claude in live mode, the heuristic in simulated mode. */
  classifier?: Classifier;
  now?: () => number;
}

const ATTENTION_PREFIX = 'lead:';
const MAX_CANDIDATES_PER_RUN = 120;

/** The sales desk: scouts collect posts, keep the promising ones, score them and hand the best to the PM. */
export class LeadScouts {
  private running: Promise<ScoutRun> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly sources: LeadSource[];
  private readonly fetchJson: FetchJson;
  private readonly now: () => number;
  private claude?: Classifier;

  constructor(private store: Store, private leads: LeadStore, private opts: ScoutOptions = {}) {
    this.sources = opts.sources ?? SOURCES;
    this.fetchJson = opts.fetchJson ?? defaultFetchJson;
    this.now = opts.now ?? Date.now;
  }

  status() {
    const runs = this.leads.runs();
    const p = this.leads.profile();
    const last = runs[runs.length - 1];
    return {
      running: !!this.running,
      lastRun: last,
      nextRunAt: p.schedule.enabled ? (last?.startedAt ?? 0) + p.schedule.everyHours * 3_600_000 : undefined,
      sources: this.sources.map((s) => ({ id: s.id, label: s.label, enabled: s.isEnabled(p) })),
    };
  }

  private classifier(): Classifier {
    if (this.opts.classifier) return this.opts.classifier;
    if (this.store.settings().mode !== 'live') return heuristicClassifier;
    return (this.claude ??= new ClaudeClassifier());
  }

  /** One sweep across every enabled source. Concurrent calls share the run already in progress. */
  run(): Promise<ScoutRun> {
    if (!this.running) {
      this.running = this.sweep().finally(() => {
        this.running = null;
        this.leads.emit('scouts', this.status());
      });
      this.leads.emit('scouts', this.status());
    }
    return this.running;
  }

  private async sweep(): Promise<ScoutRun> {
    const profile = this.leads.profile();
    const run: ScoutRun = { id: randomUUID(), startedAt: this.now(), fetched: 0, candidates: 0, created: 0, errors: [] };
    this.leads.saveRun(run);
    const since = this.now() - profile.maxAgeDays * 86_400_000;

    // 1. collect
    const raw: RawItem[] = [];
    for (const src of this.sources) {
      if (!src.isEnabled(profile)) continue;
      try {
        raw.push(...(await src.fetch(profile, since, this.fetchJson)));
      } catch (err) {
        run.errors.push(`${src.label}: ${(err as Error).message}`);
      }
    }
    run.fetched = raw.length;

    // 2. dedupe (across queries, and against everything we've looked at before)
    const fresh = new Map<string, RawItem>();
    for (const it of raw) {
      const key = `${it.source}:${it.externalId}`;
      if (it.postedAt < since || fresh.has(key) || this.leads.hasSeen(key)) continue;
      fresh.set(key, it);
    }

    // 3. cheap keyword pass; everything we drop is remembered so it's never re-checked
    const candidates: Array<{ key: string; item: RawItem; pre: ReturnType<typeof prefilter> }> = [];
    for (const [key, item] of fresh) {
      const pre = prefilter(item, profile);
      if (pre.keep && candidates.length < MAX_CANDIDATES_PER_RUN) candidates.push({ key, item, pre });
      else if (!pre.keep) this.leads.markSeen(key);
    }
    run.candidates = candidates.length;

    // 4. classify + score
    let results;
    try {
      results = await this.classifier().classify(candidates, profile);
    } catch (err) {
      run.errors.push(`Classifier: ${(err as Error).message} — used keyword matching instead`);
      results = await heuristicClassifier.classify(candidates, profile);
    }

    candidates.forEach(({ key, item }, i) => {
      const c = results[i];
      this.leads.markSeen(key);
      if (!c?.isLead || !c.lineId) return;
      const lead = this.leads.addLead({
        dedupeKey: key,
        source: item.source,
        where: item.where,
        url: item.url,
        title: item.title,
        excerpt: shorten(item.text, 1200),
        author: item.author,
        company: c.company,
        lineId: c.lineId,
        summary: c.summary,
        angle: c.angle,
        confidence: c.confidence,
        budgetHint: c.budgetHint,
        score: scoreLead(c, item, profile, this.now()),
        postedAt: item.postedAt,
      });
      run.created++;
      if (lead.score >= profile.inboxThreshold) this.postToInbox(lead);
    });

    run.finishedAt = this.now();
    this.leads.saveRun(run);
    return run;
  }

  // ---------------------------------------------------------------- the PM's side

  private postToInbox(lead: Lead) {
    const line = this.leads.profile().lines.find((l) => l.id === lead.lineId);
    const days = Math.max(0, Math.round((this.now() - lead.postedAt) / 86_400_000));
    this.store.postAttention({
      kind: 'decision',
      key: `${ATTENTION_PREFIX}${lead.id}`,
      title: `🎯 Lead (${lead.score}): ${shorten(lead.company ? `${lead.company} — ${lead.title}` : lead.title, 90)}`,
      body: `${lead.summary}\n\n**${line?.name ?? 'Lead'}** · ${lead.where ?? lead.source} · [open the post](${lead.url})${lead.angle ? `\n\n**Opening line:** ${lead.angle}` : ''}`,
      brief: {
        recommend: 'Pursue: read the post and reach out while it is fresh',
        clearsWhen: 'You pick Pursue (moves it to Reviewing in Leads) or Pass',
        whyNow: days === 0 ? 'Posted today' : `Posted ${days} day${days === 1 ? '' : 's'} ago`,
        ifItWaits: 'Public asks like this usually get answered by someone else within days',
      },
      options: [
        { id: 'pursue', label: 'Pursue', primary: true },
        { id: 'pass', label: 'Pass' },
      ],
    });
  }

  /** Called for inbox answers on lead items. Returns true when it handled the item. */
  onAttentionResolved(item: AttentionItem, option?: string) {
    if (!item.key.startsWith(ATTENTION_PREFIX)) return false;
    const id = item.key.slice(ATTENTION_PREFIX.length);
    if (option === 'pursue') this.setStatus(id, 'reviewing');
    else if (option === 'pass') this.setStatus(id, 'passed');
    return true;
  }

  setStatus(id: string, status: LeadStatus) {
    const l = this.leads.lead(id);
    if (!l) throw Object.assign(new Error('Lead not found'), { status: 404 });
    if (status === 'won') return this.win(id);
    const updated = this.leads.updateLead(id, { status });
    if (status !== 'new') this.closeInbox(id);
    return updated;
  }

  /** Won: the lead becomes a project kickoff ticket in the Backlog. */
  win(id: string, projectId?: string): Lead {
    const l = this.leads.lead(id);
    if (!l) throw Object.assign(new Error('Lead not found'), { status: 404 });
    let ticket: Ticket | undefined = l.ticketId ? this.store.ticket(l.ticketId) : undefined;
    if (!ticket) {
      const line = this.leads.profile().lines.find((x) => x.id === l.lineId);
      ticket = this.store.createTicket({
        title: shorten(`Kick off: ${l.company || l.title}`, 70),
        projectId,
        stage: 'backlog',
        priority: 'high',
        labels: ['lead', ...(l.lineId ? [l.lineId] : [])],
        source: 'local',
        externalUrl: l.url,
        description: [
          '## Context',
          `Won lead (${line?.name ?? 'new work'}). ${l.summary}`,
          '',
          `Source: [${l.where ?? l.source}](${l.url})`,
          '',
          '## Acceptance criteria',
          '- [ ] Scope confirmed with the client and written up as tickets',
          '- [ ] Repository access and environments set up',
          '- [ ] First milestone agreed',
          ...(l.notes.length ? ['', '## Notes from the lead', ...l.notes.map((n) => `- ${n.text}`)] : []),
        ].join('\n'),
      });
    }
    this.closeInbox(id);
    return this.leads.updateLead(id, { status: 'won', ticketId: ticket.id })!;
  }

  private closeInbox(id: string) {
    const open = this.store.openAttention(`${ATTENTION_PREFIX}${id}`);
    if (open) this.store.updateAttention(open.id, { status: 'dismissed' });
  }

  // ---------------------------------------------------------------- schedule

  startSchedule(everyMs = 60_000) {
    this.stopSchedule();
    this.timer = setInterval(() => {
      const s = this.status();
      if (s.nextRunAt !== undefined && !s.running && this.now() >= s.nextRunAt) this.run().catch(() => undefined);
    }, everyMs);
    this.timer.unref?.();
  }

  stopSchedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
