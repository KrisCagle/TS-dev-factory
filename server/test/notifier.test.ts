import { describe, expect, it } from 'vitest';
import { Notifier, type Notice } from '../src/notifier.js';
import { Store } from '../src/store.js';
import { tmpData } from './helpers.js';

function setup(patch: Partial<ReturnType<Store['settings']>['notifications']> = {}) {
  const store = new Store(tmpData());
  store.updateSettings({ notifications: { ...store.settings().notifications, enabled: true, macos: false, browser: true, slack: { enabled: false, webhookUrl: '' }, quietHours: { enabled: false, from: '18:00', to: '08:00' }, ...patch } });
  const sent: Notice[] = [];
  const n = new Notifier(store, (m) => sent.push((m as { notice: Notice }).notice));
  return { store, n, sent };
}

describe('notifications', () => {
  it('pings when something new needs you', () => {
    const { store, sent } = setup();
    const t = store.createTicket({ title: 'x' });
    store.postAttention({ kind: 'review', key: `merge:${t.id}`, ticketId: t.id, title: `Sign off ${t.key}: x` });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: 'needsYou', ticketId: t.id });
  });

  it('pings when a ticket ships or fails', () => {
    const { store, sent } = setup();
    const t = store.createTicket({ title: 'x', stage: 'ready' });
    store.updateTicket(t.id, { stage: 'done' });
    const u = store.createTicket({ title: 'y', stage: 'ready' });
    store.updateTicket(u.id, { stage: 'failed', error: 'Build broke' });
    expect(sent.map((s) => s.event)).toEqual(['shipped', 'failed']);
  });

  it('respects the master switch and per-event toggles', () => {
    const off = setup({ enabled: false });
    off.n.notify({ event: 'shipped', title: 'a', body: '' });
    expect(off.sent).toHaveLength(0);
    const some = setup({ events: { needsYou: true, ciFailed: true, shipped: false, failed: true, stuck: true } });
    some.n.notify({ event: 'shipped', title: 'a', body: '' });
    some.n.notify({ event: 'failed', title: 'b', body: '' });
    expect(some.sent.map((s) => s.event)).toEqual(['failed']);
  });

  it('does not repeat the same ping within a minute', () => {
    const { n, sent } = setup();
    n.notify({ event: 'failed', title: 'a', body: '', ticketId: 't' });
    n.notify({ event: 'failed', title: 'a', body: '', ticketId: 't' });
    expect(sent).toHaveLength(1);
  });

  it('stays quiet in quiet hours, except for tests you send yourself', () => {
    const { n, sent } = setup({ quietHours: { enabled: true, from: '00:00', to: '23:59' } });
    n.notify({ event: 'failed', title: 'a', body: '' });
    expect(sent).toHaveLength(0);
    n.notify({ event: 'needsYou', title: 'test', body: '' }, { force: true });
    expect(sent).toHaveLength(1);
  });
});
