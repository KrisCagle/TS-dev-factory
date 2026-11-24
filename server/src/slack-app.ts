import WebSocket from 'ws';
import type { Orchestrator } from './orchestrator.js';
import type { Store } from './store.js';
import type { AttentionItem, Ticket } from './types.js';

/**
 * Approve from Slack. Sign-offs and decisions are posted to a channel with buttons;
 * clicks come back over Slack's Socket Mode, so no public URL is needed.
 * When an item is answered (in Slack or in the factory) the message is updated.
 */

export type SlackCall = (method: string, body: Record<string, unknown>, token: string) => Promise<Record<string, any>>;

export const slackCall: SlackCall = async (method, body, token) => {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, any>;
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error ?? res.status}`);
  return data;
};

const POSTABLE = (a: AttentionItem) => a.status === 'open' && (a.kind === 'review' || a.kind === 'decision' || a.kind === 'error');

/** The Slack message for an inbox item: what it is, the recommendation, and one button per choice. */
export function itemBlocks(a: AttentionItem, t: Ticket | undefined, factoryUrl: string) {
  const link = t ? `${factoryUrl.replace(/\/$/, '')}/#inbox` : undefined;
  const facts = [
    t?.confidence ? `🛡 Safety ${t.confidence.score}/100` : '',
    t?.testReport?.criteria?.length ? `✅ ${t.testReport.criteria.filter((c) => c.status === 'proven').length}/${t.testReport.criteria.length} criteria proven` : '',
    t?.ci?.state === 'success' ? '🚦 CI green' : '',
    t?.prUrl ? `<${t.prUrl}|PR>` : '',
  ].filter(Boolean).join('  ·  ');
  const blocks: Record<string, unknown>[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${escape(a.title)}*${a.review?.summary ? `\n${escape(a.review.summary)}` : ''}` } },
  ];
  if (facts) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: facts }] });
  if (a.brief) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Recommend:* ${escape(a.brief.recommend)}\n_If it waits:_ ${escape(a.brief.ifItWaits)}` } });
  const buttons = (a.options ?? []).slice(0, 4).map((o) => ({
    type: 'button',
    text: { type: 'plain_text', text: o.needsText ? `${o.label}…` : o.label, emoji: true },
    action_id: `factory:${o.id}`,
    value: `${a.id}|${o.id}|${o.needsText ? 1 : 0}`,
    ...(o.primary ? { style: 'primary' } : o.id === 'sendback' || o.id === 'revert' ? { style: 'danger' } : {}),
  }));
  if (link) buttons.push({ type: 'button', text: { type: 'plain_text', text: 'Open in factory ↗', emoji: true }, action_id: 'factory:open', value: 'open', url: link } as never);
  if (buttons.length) blocks.push({ type: 'actions', block_id: `factory-${a.id}`, elements: buttons });
  return blocks;
}

export function doneBlocks(a: AttentionItem, by: string) {
  const what = a.resolution?.option ?? a.status;
  const verb: Record<string, string> = { ship: '🚀 Approved & shipped', approve: '✅ Approved', sendback: '↩ Sent back', retry: '↻ Retried', revert: '↩ Reverted', backlog: '🗂 Parked', fixforward: '🛠 Fix ticket opened', keep: '👌 Kept' };
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `~${escape(a.title)}~` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${verb[what] ?? (a.status === 'dismissed' ? '✔ No longer needed' : '✔ Answered')}${by ? ` by ${by}` : ''}${a.resolution?.text ? ` — “${escape(a.resolution.text)}”` : ''}` }] },
  ];
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class SlackApp {
  private ws?: WebSocket;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  /** item id → where we posted it */
  private posted = new Map<string, { channel: string; ts: string }>();
  private answeredBy = new Map<string, string>();
  status: { connected: boolean; error?: string } = { connected: false };

  constructor(private store: Store, private orch: Pick<Orchestrator, 'resolve'>, private call: SlackCall = slackCall) {
    for (const t of store.tickets()) if (t.slack) this.posted.set(t.slack.itemId, { channel: t.slack.channel, ts: t.slack.ts });
    store.on('attention', (items: AttentionItem[]) => void this.sync(items));
  }

  private cfg() {
    return this.store.settings().slackApp;
  }

  private ready() {
    const c = this.cfg();
    return c.enabled && !!c.botToken && !!c.channel;
  }

  /** Post new items; update the message of anything that was answered. */
  async sync(items: AttentionItem[]) {
    if (!this.ready()) return;
    const c = this.cfg();
    for (const a of items) {
      const where = this.posted.get(a.id);
      try {
        if (!where && POSTABLE(a)) {
          this.posted.set(a.id, { channel: c.channel, ts: 'pending' });
          const t = a.ticketId ? this.store.ticket(a.ticketId) : undefined;
          const r = await this.call('chat.postMessage', { channel: c.channel, text: a.title, blocks: itemBlocks(a, t, c.factoryUrl), unfurl_links: false }, c.botToken);
          this.posted.set(a.id, { channel: r.channel, ts: r.ts });
          if (t) this.store.updateTicket(t.id, { slack: { channel: r.channel, ts: r.ts, itemId: a.id } });
        } else if (where && where.ts !== 'pending' && a.status !== 'open' && a.status !== 'held') {
          this.posted.delete(a.id);
          await this.call('chat.update', { channel: where.channel, ts: where.ts, text: a.title, blocks: doneBlocks(a, this.answeredBy.get(a.id) ?? '') }, c.botToken);
        }
      } catch (e) {
        this.status.error = e instanceof Error ? e.message : String(e);
        if (where?.ts === 'pending' || !where) this.posted.delete(a.id);
      }
    }
  }

  /** One Socket Mode envelope from Slack (a button click or a modal submit). Returns what to send back. */
  async handle(payload: Record<string, any>): Promise<{ ok: boolean; message?: string }> {
    const c = this.cfg();
    const user = payload.user?.id as string | undefined;
    const who = (payload.user?.name as string | undefined) ?? (payload.user?.username as string | undefined) ?? 'someone';
    const allowed = !c.approvers.length || (!!user && c.approvers.includes(user));

    if (payload.type === 'block_actions') {
      const action = payload.actions?.[0];
      if (!action || action.action_id === 'factory:open') return { ok: true };
      const [itemId, option, needsText] = String(action.value).split('|');
      if (!allowed) return this.deny(payload, c.botToken);
      if (needsText === '1') {
        // ask for the note in a modal
        await this.call('views.open', {
          trigger_id: payload.trigger_id,
          view: {
            type: 'modal',
            callback_id: 'factory:note',
            private_metadata: `${itemId}|${option}`,
            title: { type: 'plain_text', text: 'Note for the agents' },
            submit: { type: 'plain_text', text: 'Send' },
            close: { type: 'plain_text', text: 'Cancel' },
            blocks: [{ type: 'input', block_id: 'note', label: { type: 'plain_text', text: 'What should change?' }, element: { type: 'plain_text_input', action_id: 'text', multiline: true } }],
          },
        }, c.botToken);
        return { ok: true };
      }
      return this.answer(itemId, option, undefined, who);
    }

    if (payload.type === 'view_submission' && payload.view?.callback_id === 'factory:note') {
      if (!allowed) return { ok: false, message: 'not allowed' };
      const [itemId, option] = String(payload.view.private_metadata).split('|');
      const text = payload.view.state?.values?.note?.text?.value as string | undefined;
      return this.answer(itemId, option, text, who);
    }
    return { ok: true };
  }

  private answer(itemId: string, option: string, text: string | undefined, who: string) {
    try {
      this.answeredBy.set(itemId, who);
      this.orch.resolve(itemId, { option, text });
      const item = this.store.attentionItem(itemId);
      if (item?.ticketId) this.store.log({ ticketId: item.ticketId, agent: 'pm', kind: 'pm', text: `Answered in Slack by ${who}: ${option}${text ? ` — ${text}` : ''}` });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  private async deny(payload: Record<string, any>, token: string) {
    if (payload.channel?.id && payload.user?.id) {
      await this.call('chat.postEphemeral', { channel: payload.channel.id, user: payload.user.id, text: 'Only the approvers listed in the factory’s Slack settings can answer these.' }, token).catch(() => undefined);
    }
    return { ok: false, message: 'not allowed' };
  }

  // ------------------------------------------------------------------ Socket Mode connection
  start() {
    this.stopped = false;
    void this.connect();
    this.store.on('settings', () => {
      const c = this.cfg();
      const want = c.enabled && !!c.appToken;
      if (want && !this.ws) void this.connect();
      if (!want && this.ws) this.disconnect();
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.disconnect();
  }

  private disconnect() {
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = undefined;
    this.status.connected = false;
  }

  private async connect() {
    const c = this.cfg();
    if (this.stopped || !c.enabled || !c.appToken || this.ws) return;
    try {
      const r = await this.call('apps.connections.open', {}, c.appToken);
      const ws = new WebSocket(r.url as string);
      this.ws = ws;
      ws.on('open', () => {
        this.status = { connected: true };
      });
      ws.on('message', async (data) => {
        let env: Record<string, any>;
        try {
          env = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (env.type === 'disconnect') {
          this.disconnect();
          void this.connect();
          return;
        }
        if (!env.envelope_id) return;
        // acknowledge within 3 seconds, then do the work
        ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
        if (env.type === 'interactive') await this.handle(env.payload ?? {}).catch(() => undefined);
      });
      ws.on('close', () => {
        this.ws = undefined;
        this.status.connected = false;
        if (!this.stopped) this.retry = setTimeout(() => void this.connect(), 5000);
      });
      ws.on('error', (e) => {
        this.status.error = e.message;
      });
    } catch (e) {
      this.status = { connected: false, error: e instanceof Error ? e.message : String(e) };
      if (!this.stopped) this.retry = setTimeout(() => void this.connect(), 30_000);
    }
  }

  /** Check the tokens: who the bot is, and that Socket Mode can connect. */
  async test() {
    const c = this.cfg();
    if (!c.botToken) throw new Error('Add the bot token (xoxb-…) first.');
    const me = await this.call('auth.test', {}, c.botToken);
    if (c.appToken) await this.call('apps.connections.open', {}, c.appToken);
    else throw new Error('Add the app-level token (xapp-…) so button clicks can reach the factory.');
    return `Connected as ${me.user} in ${me.team}. Button clicks will arrive over Socket Mode.`;
  }
}
