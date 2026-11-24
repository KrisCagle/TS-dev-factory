import { spawn } from 'node:child_process';
import { http } from './connectors/types.js';
import type { Store } from './store.js';
import type { AttentionItem, NotifyEvent, Stage, Ticket } from './types.js';

export interface Notice {
  event: NotifyEvent;
  title: string;
  body: string;
  ticketId?: string;
}

const EVENT_LABEL: Record<NotifyEvent, string> = {
  needsYou: 'Needs you',
  ciFailed: 'CI failed',
  shipped: 'Shipped',
  failed: 'Failed',
  stuck: 'Agent stuck',
};

export function inQuietHours(from: string, to: string, now = new Date()) {
  const m = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const f = fh * 60 + fm;
  const t = th * 60 + tm;
  return f <= t ? m >= f && m < t : m >= f || m < t; // handles overnight windows
}

/**
 * Tells the PM when something happens: macOS notification, browser notification and/or Slack.
 * Every channel and every event can be switched off in Settings → Notifications.
 */
export class Notifier {
  private seenOpen = new Set<string>();
  private stages = new Map<string, Stage>();
  private recent = new Map<string, number>();

  constructor(private store: Store, private broadcast: (msg: unknown) => void) {
    for (const a of store.attention()) if (a.status === 'open') this.seenOpen.add(a.id);
    for (const t of store.tickets()) this.stages.set(t.id, t.stage);

    store.on('attention', (items: AttentionItem[]) => {
      for (const a of items) {
        if (a.status !== 'open' || this.seenOpen.has(a.id)) continue;
        this.seenOpen.add(a.id);
        if (a.kind === 'error') continue; // the ticket's move to Failed covers it
        const t = a.ticketId ? store.ticket(a.ticketId) : undefined;
        const stuck = a.key.startsWith('stuck:');
        this.notify({
          event: stuck ? 'stuck' : 'needsYou',
          title: stuck ? `⏰ ${a.title}` : `✋ ${a.kind === 'review' ? 'Ready for your sign-off' : 'Decision needed'}${t ? ` · ${t.key}` : ''}`,
          body: a.kind === 'review' ? a.title.replace(/^Sign off [A-Z]+-\d+:\s*/, '') : a.brief?.recommend ?? a.title,
          ticketId: a.ticketId,
        });
      }
    });

    store.on('ticket', (t: Ticket) => {
      const prev = this.stages.get(t.id);
      this.stages.set(t.id, t.stage);
      if (prev === t.stage || prev === undefined) return;
      if (t.stage === 'done') this.notify({ event: 'shipped', title: `🚀 Shipped ${t.key}`, body: t.title, ticketId: t.id });
      if (t.stage === 'failed' && !t.error?.startsWith('Stuck') && !/stopped responding/.test(t.error ?? '')) {
        this.notify({ event: 'failed', title: `⚠️ ${t.key} failed`, body: t.error?.slice(0, 140) ?? t.title, ticketId: t.id });
      }
    });

    store.on('notify', (n: Notice) => this.notify(n));
  }

  notify(n: Notice, opts: { force?: boolean } = {}) {
    const s = this.store.settings().notifications;
    if (!opts.force) {
      if (!s.enabled || !s.events[n.event]) return;
      if (s.quietHours.enabled && inQuietHours(s.quietHours.from, s.quietHours.to)) return;
      const k = `${n.event}:${n.ticketId ?? n.title}`;
      if (Date.now() - (this.recent.get(k) ?? 0) < 60_000) return; // no repeats within a minute
      this.recent.set(k, Date.now());
    }
    if (s.macos && process.platform === 'darwin') this.macos(n);
    if (s.browser) this.broadcast({ type: 'notify', notice: n });
    // the Slack app already posts inbox items with buttons, so don't post them twice
    const app = this.store.settings().slackApp;
    const viaApp = n.event === 'needsYou' && app.enabled && !!app.botToken && !!app.channel;
    if (s.slack.enabled && s.slack.webhookUrl && !viaApp) void this.slack(n).catch((e) => console.error('[notify] slack:', e.message));
  }

  private macos(n: Notice) {
    const q = (x: string) => x.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `display notification "${q(n.body)}" with title "AI Dev Factory" subtitle "${q(n.title)}" sound name "Glass"`;
    const p = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    p.on('error', () => undefined);
  }

  async slack(n: Notice | { text: string }) {
    const url = this.store.settings().notifications.slack.webhookUrl;
    if (!url) throw new Error('Add a Slack webhook URL first.');
    const text = 'text' in n ? n.text : `*${n.title}*\n${n.body}${n.ticketId ? '' : ''}`;
    await http(url, { method: 'POST', json: { text } }).catch(async (e) => {
      // Slack webhooks answer with plain "ok", which isn't JSON — treat that as success.
      if (!/Unexpected token|JSON/.test((e as Error).message)) throw e;
    });
  }

  label(e: NotifyEvent) {
    return EVENT_LABEL[e];
  }
}
