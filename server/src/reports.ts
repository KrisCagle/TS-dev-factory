import { harvest, harvestConfigured, isoDay } from './connectors/harvest.js';
import type { Notifier } from './notifier.js';
import type { Store } from './store.js';
import type { Ticket } from './types.js';

export type Range = 'day' | 'week';

export interface Report {
  range: Range;
  from: string;
  to: string;
  project: string;
  shipped: Array<{ key: string; title: string; prUrl?: string }>;
  needsYou: Array<{ key: string; title: string }>;
  inProgress: Array<{ key: string; title: string; stage: string }>;
  blocked: Array<{ key: string; title: string; why: string }>;
  spendUsd: number;
  harvestHours?: number;
  markdown: string;
}

const STAGE_WORDS: Record<string, string> = {
  planning: 'planning', coding: 'coding', testing: 'testing', reviewing: 'in review', ci: 'waiting on CI', ready: 'queued',
};

/** Standups and weekly reports, built from what the factory actually did. */
export class Reports {
  constructor(private store: Store, private notifier: Notifier) {}

  private window(range: Range) {
    const now = new Date();
    const start = new Date(now);
    if (range === 'day') {
      // "since yesterday's standup": from the start of the previous working day
      start.setDate(now.getDate() - (now.getDay() === 1 ? 3 : 1));
    } else start.setDate(now.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    return { start, end: now };
  }

  async build(range: Range, projectId?: string): Promise<Report> {
    const { start, end } = this.window(range);
    const inProject = (t: Ticket) => !projectId || t.projectId === projectId;
    const tickets = this.store.tickets().filter(inProject);
    const since = start.getTime();

    const shipped = tickets.filter((t) => t.stage === 'done' && (t.finishedAt ?? 0) >= since).sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    const open = this.store.attention().filter((a) => a.status === 'open' && (!projectId || tickets.some((t) => t.id === a.ticketId)));
    const needsYou = open.map((a) => ({ key: tickets.find((t) => t.id === a.ticketId)?.key ?? '', title: a.title.replace(/^Sign off [A-Z]+-\d+:\s*/, 'Sign off: ') }));
    const inProgress = tickets.filter((t) => STAGE_WORDS[t.stage]).map((t) => ({ key: t.key, title: t.title, stage: STAGE_WORDS[t.stage] }));
    const blocked = tickets.filter((t) => t.stage === 'failed').map((t) => ({ key: t.key, title: t.title, why: (t.error ?? 'failed').slice(0, 120) }));
    const spendUsd = +tickets.filter((t) => t.updatedAt >= since).reduce((a, t) => a + t.costUsd, 0).toFixed(2);

    let harvestHours: number | undefined;
    const s = this.store.settings();
    if (harvestConfigured(s)) {
      try {
        const entries = await harvest.entriesBetween(s, isoDay(start), isoDay(end));
        harvestHours = +entries.reduce((a, e) => a + e.hours, 0).toFixed(2);
      } catch {
        /* leave it out */
      }
    }

    const project = projectId ? this.store.project(projectId).name : 'All projects';
    const title = range === 'day' ? `Standup — ${end.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}` : `Week of ${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    const list = <T,>(xs: T[], f: (x: T) => string, empty: string) => (xs.length ? xs.map((x) => `- ${f(x)}`).join('\n') : `- ${empty}`);
    const markdown = `### ${title} · ${project}

**${range === 'day' ? 'Shipped since last working day' : 'Shipped this week'}** (${shipped.length})
${list(shipped, (t) => `${t.key} ${t.title}${t.prUrl ? ` (${t.prUrl})` : ''}`, 'Nothing shipped')}

**In progress** (${inProgress.length})
${list(inProgress, (t) => `${t.key} ${t.title} — ${t.stage}`, 'Nothing in flight')}

**Waiting on me** (${needsYou.length})
${list(needsYou, (t) => `${t.key} ${t.title}`, 'Nothing — all clear')}

**Blocked** (${blocked.length})
${list(blocked, (t) => `${t.key} ${t.title} — ${t.why}`, 'Nothing blocked')}

_Agent spend: $${spendUsd.toFixed(2)}${harvestHours !== undefined ? ` · Hours logged in Harvest: ${harvestHours}` : ''}_`;

    return { range, from: isoDay(start), to: isoDay(end), project, shipped: shipped.map((t) => ({ key: t.key, title: t.title, prUrl: t.prUrl })), needsYou, inProgress, blocked, spendUsd, harvestHours, markdown };
  }

  async postToSlack(range: Range, projectId?: string) {
    const r = await this.build(range, projectId);
    await this.notifier.slack({ text: r.markdown.replace(/^### /, '*').replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/ · (.+)$/m, ' · $1*') });
    return r;
  }

  /** Weekday morning standup to Slack, if switched on. */
  private timer?: NodeJS.Timeout;

  startSchedule() {
    this.timer = setInterval(() => {
      const s = this.store.settings();
      if (!s.reports.dailySlack || !s.notifications.slack.webhookUrl) return;
      const now = new Date();
      if (now.getDay() === 0 || now.getDay() === 6) return;
      const today = isoDay(now);
      const [h, m] = s.reports.dailyTime.split(':').map(Number);
      if (s.reports.lastSent === today || now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
      this.store.updateSettings({ reports: { ...s.reports, lastSent: today } });
      void this.postToSlack('day').catch((e) => console.error('[reports] daily standup:', e.message));
    }, 60_000);
  }

  stopSchedule() {
    if (this.timer) clearInterval(this.timer);
  }
}
