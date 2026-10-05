import crypto from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { priorityFor, stackTrace, ticketTitle, toTicket, verifySignature, type SentryEvent, type SentryIssue } from '../src/connectors/sentry.js';
import { SlackApp, doneBlocks, itemBlocks, type SlackCall } from '../src/slack-app.js';
import { makeFactory, openItem, waitFor, waitForStage, type TestFactory } from './helpers.js';

const ISSUE: SentryIssue = {
  id: '4401', shortId: 'WEB-1A', title: "TypeError: Cannot read properties of undefined (reading 'id')", culprit: 'checkout.submitOrder',
  permalink: 'https://sentry.io/organizations/acme/issues/4401/', level: 'error', count: '312', userCount: 41, lastSeen: '2026-10-05T14:03:11Z',
  metadata: { type: 'TypeError', value: "Cannot read properties of undefined (reading 'id')", function: 'submitOrder' },
};
const EVENT: SentryEvent = {
  entries: [{
    type: 'exception',
    data: { values: [{ type: 'TypeError', value: "Cannot read properties of undefined (reading 'id')", stacktrace: { frames: [
      { filename: 'node_modules/react-dom/index.js', function: 'commit', lineNo: 1, inApp: false },
      { filename: 'src/checkout/api.ts', function: 'post', lineNo: 40, inApp: true },
      { filename: 'src/checkout/submit.ts', function: 'submitOrder', lineNo: 88, colNo: 12, inApp: true },
    ] } }] },
  }],
};

describe('Sentry → tickets', () => {
  it('turns an issue into a ticket with the trace and acceptance criteria', () => {
    const t = toTicket(ISSUE, EVENT);
    expect(t.title).toBe("Fix submitOrder: TypeError: Cannot read properties of undefined (reading 'id')");
    expect(t.priority).toBe('high');
    expect(t.labels).toEqual(['bug', 'sentry']);
    expect(t.externalId).toBe('4401');
    expect(t.key).toBe('SEN-1A');
    expect(t.description).toContain('312 events, 41 users');
    expect(t.description).toContain('at submitOrder (src/checkout/submit.ts:88:12)');
    expect(t.description).not.toContain('react-dom'); // app frames only
    expect(t.description).toContain('## Acceptance criteria');
  });
  it('orders the trace newest-call first and falls back to library frames', () => {
    const lines = stackTrace(EVENT).split('\n');
    expect(lines[1]).toContain('submitOrder');
    expect(stackTrace({ entries: [{ type: 'exception', data: { values: [{ type: 'E', value: 'x', stacktrace: { frames: [{ filename: 'lib.js', function: 'f', inApp: false }] } }] } }] })).toContain('[library]');
    expect(stackTrace(undefined)).toBe('');
  });
  it('picks priority from severity and reach', () => {
    expect(priorityFor({ level: 'fatal' })).toBe('urgent');
    expect(priorityFor({ level: 'error', userCount: 250 })).toBe('urgent');
    expect(priorityFor({ level: 'error', count: '5' })).toBe('medium');
    expect(priorityFor({ level: 'warning' })).toBe('low');
    expect(ticketTitle({ ...ISSUE, metadata: undefined, culprit: undefined }).startsWith('Fix TypeError')).toBe(true);
  });
  it('verifies webhook signatures', () => {
    const body = JSON.stringify({ a: 1 });
    const sig = crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
    expect(verifySignature(body, sig, 's3cret')).toBe(true);
    expect(verifySignature(body, sig, 'wrong')).toBe(false);
    expect(verifySignature(body, undefined, 's3cret')).toBe(false);
    expect(verifySignature(body, sig, '')).toBe(false);
  });
});

let f: TestFactory;
afterEach(async () => f?.close());

describe('Sentry webhook', () => {
  it('creates a ticket for a new issue only with a valid signature, once', async () => {
    f = makeFactory();
    f.store.updateSettings({ connectors: { ...f.store.settings().connectors, sentry: { ...f.store.settings().connectors.sentry, enabled: true, webhookSecret: 'hook' } } });
    const api = request(f.app);
    const body = JSON.stringify({ action: 'created', data: { issue: ISSUE } });
    const sig = crypto.createHmac('sha256', 'hook').update(body).digest('hex');
    const send = (signature: string) => api.post('/api/webhooks/sentry').set('content-type', 'application/json').set('sentry-hook-resource', 'issue').set('sentry-hook-signature', signature).send(body);
    await send('bad').expect(401);
    const r = (await send(sig).expect(200)).body;
    expect(r.created).toBe('SEN-1A');
    expect((await send(sig).expect(200)).body).toEqual({ duplicate: true });
    const t = f.store.tickets().find((x) => x.source === 'sentry')!;
    expect(t).toMatchObject({ stage: 'backlog', priority: 'high', externalUrl: ISSUE.permalink });
    expect(JSON.stringify((await api.get('/api/state')).body)).not.toContain('"hook"');
  });
});

describe('Slack app (approve from Slack)', () => {
  const fakeSlack = () => {
    const calls: Array<{ method: string; body: Record<string, any> }> = [];
    const call: SlackCall = async (method, body) => {
      calls.push({ method, body });
      if (method === 'chat.postMessage') return { ok: true, channel: 'C1', ts: `${calls.length}.0001` };
      return { ok: true };
    };
    return { calls, call };
  };
  const enable = (extra = {}) => f.store.updateSettings({ slackApp: { ...f.store.settings().slackApp, enabled: true, botToken: 'xoxb-1', appToken: 'xapp-1', channel: 'C1', ...extra } });

  it('builds a message with the recommendation and a button per choice', () => {
    const blocks = itemBlocks({ id: 'i1', kind: 'review', key: 'merge:t', title: 'Sign off FAC-1: CSV', status: 'open', createdAt: 0, updatedAt: 0, brief: { recommend: 'Ship it', clearsWhen: '', whyNow: '', ifItWaits: 'drift' }, options: [{ id: 'ship', label: 'Approve & ship', primary: true }, { id: 'sendback', label: 'Send back', needsText: true }] }, { confidence: { score: 92, level: 'high', reasons: [] } } as never, 'http://localhost:4317');
    const text = JSON.stringify(blocks);
    expect(text).toContain('Sign off FAC-1: CSV');
    expect(text).toContain('Safety 92/100');
    expect(text).toContain('"value":"i1|ship|0"');
    expect(text).toContain('"value":"i1|sendback|1"');
    expect(text).toContain('Send back…');
    expect(JSON.stringify(doneBlocks({ title: 'x', status: 'resolved', resolution: { option: 'ship', at: 0 } } as never, 'kris'))).toContain('Approved & shipped by kris');
  });

  it('posts sign-offs, ships on a button click, and updates the message', async () => {
    f = makeFactory();
    const s = fakeSlack();
    const app = new SlackApp(f.store, f.orch, s.call);
    enable();
    f.orch.start();
    const t = f.store.createTicket({ title: 'Slack me', stage: 'ready' });
    await waitForStage(f, t.id, 'awaiting_approval');
    const post = await waitFor(() => s.calls.find((c) => c.method === 'chat.postMessage' && JSON.stringify(c.body).includes(`Sign off ${t.key}`)), { what: 'slack post' });
    const ship = post.body.blocks.find((b: { type: string }) => b.type === 'actions').elements.find((e: { action_id: string }) => e.action_id === 'factory:ship');
    expect(f.store.ticket(t.id)!.slack?.channel).toBe('C1');

    const r = await app.handle({ type: 'block_actions', user: { id: 'U1', name: 'kris' }, actions: [{ action_id: 'factory:ship', value: ship.value }] });
    expect(r.ok).toBe(true);
    await waitForStage(f, t.id, 'done');
    const upd = await waitFor(() => s.calls.find((c) => c.method === 'chat.update'), { what: 'message update' });
    expect(JSON.stringify(upd.body.blocks)).toContain('by kris');
    expect(f.store.logs(t.id).some((l) => /Answered in Slack by kris: ship/.test(l.text))).toBe(true);
  });

  it('asks for a note in a modal before sending back, and respects the approver list', async () => {
    f = makeFactory();
    const s = fakeSlack();
    const app = new SlackApp(f.store, f.orch, s.call);
    enable({ approvers: ['U_BOSS'] });
    f.orch.start();
    const t = f.store.createTicket({ title: 'Send me back', stage: 'ready' });
    await waitForStage(f, t.id, 'awaiting_approval');
    const item = openItem(f, t.id, 'merge:')!;

    const denied = await app.handle({ type: 'block_actions', user: { id: 'U_RANDO' }, channel: { id: 'C1' }, actions: [{ action_id: 'factory:ship', value: `${item.id}|ship|0` }] });
    expect(denied.ok).toBe(false);
    expect(s.calls.some((c) => c.method === 'chat.postEphemeral')).toBe(true);
    expect(f.store.ticket(t.id)!.stage).toBe('awaiting_approval');

    await app.handle({ type: 'block_actions', trigger_id: 'T1', user: { id: 'U_BOSS' }, actions: [{ action_id: 'factory:sendback', value: `${item.id}|sendback|1` }] });
    const modal = s.calls.find((c) => c.method === 'views.open')!;
    expect(modal.body.view.private_metadata).toBe(`${item.id}|sendback`);

    const r = await app.handle({ type: 'view_submission', user: { id: 'U_BOSS', name: 'boss' }, view: { callback_id: 'factory:note', private_metadata: `${item.id}|sendback`, state: { values: { note: { text: { value: 'Use the brand colour' } } } } } });
    expect(r.ok).toBe(true);
    await waitFor(() => f.store.ticket(t.id)!.notes.some((n) => n.text.includes('Use the brand colour')), { what: 'note' });
  });

  it('stays silent when the Slack app is off', async () => {
    f = makeFactory();
    const s = fakeSlack();
    new SlackApp(f.store, f.orch, s.call);
    f.store.postAttention({ kind: 'decision', key: 'k:1', ticketId: 'x', title: 'Q', options: [{ id: 'ok', label: 'OK' }] });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.calls).toHaveLength(0);
  });
});
