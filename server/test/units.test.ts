import { describe, expect, it } from 'vitest';
import * as A from '../src/attention.js';
import { inQuietHours } from '../src/notifier.js';
import { Scoper } from '../src/scoper.js';
import { Store } from '../src/store.js';
import { seeded } from '../src/agents/mock.js';
import type { AttentionItem, Ticket } from '../src/types.js';
import { tmpData } from './helpers.js';

const at = (h: number, m = 0) => { const d = new Date(2026, 0, 5); d.setHours(h, m, 0, 0); return d; };

describe('quiet hours', () => {
  it('handles a same-day window', () => {
    expect(inQuietHours('12:00', '13:00', at(12, 30))).toBe(true);
    expect(inQuietHours('12:00', '13:00', at(13, 0))).toBe(false);
    expect(inQuietHours('12:00', '13:00', at(11, 59))).toBe(false);
  });
  it('handles an overnight window', () => {
    expect(inQuietHours('18:00', '08:00', at(23))).toBe(true);
    expect(inQuietHours('18:00', '08:00', at(7, 59))).toBe(true);
    expect(inQuietHours('18:00', '08:00', at(8))).toBe(false);
    expect(inQuietHours('18:00', '08:00', at(12))).toBe(false);
  });
});

describe('seeded randomness', () => {
  it('is reproducible', () => {
    const a = seeded(7), b = seeded(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(seeded(8)()).not.toEqual(seeded(7)());
  });
});

describe('inbox briefs', () => {
  const ticket = (over: Partial<Ticket> = {}) => {
    const s = new Store(tmpData());
    return { ...s.createTicket({ title: 'Add CSV export' }), ...over } as Ticket;
  };

  it('every decision carries a full brief', () => {
    const t = ticket({ plan: { summary: 's', steps: ['a'], risks: ['r1'], files: [] } });
    for (const item of [A.planGate(t), A.signoff(t), A.escalation(t, 'loops'), A.failure(t, 'boom'), A.stuck(t, 'Coder', 5, 2), A.ciTooSlow(t, 40)]) {
      expect(item.brief?.recommend, item.key).toBeTruthy();
      expect(item.brief?.clearsWhen, item.key).toBeTruthy();
      expect(item.brief?.whyNow, item.key).toBeTruthy();
      expect(item.brief?.ifItWaits, item.key).toBeTruthy();
      expect(item.ticketId).toBe(t.id);
    }
  });

  it('mentions the first plan risk in the recommendation', () => {
    expect(A.planGate(ticket({ plan: { summary: 's', steps: [], risks: ['DB migration'], files: [] } })).brief!.recommend).toContain('DB migration');
  });

  it('keys are stable per ticket so re-asking supersedes', () => {
    const t = ticket();
    expect(A.signoff(t).key).toBe(A.keys.signoff(t));
    expect(A.signoff(t, 'CI running').key).toBe(A.keys.signoff(t));
  });

  it('consolidates walkthrough feedback into one message', () => {
    const item = { review: { cases: [{ title: 'Happy path', steps: [], expect: '' }, { title: 'Empty input', steps: [], expect: '' }] } } as unknown as AttentionItem;
    const ok = A.consolidate(item, [{ verdict: 'approved' }, { verdict: 'approved' }]);
    expect(ok.allApproved).toBe(true);
    expect(ok.feedback).toBe('');
    const bad = A.consolidate(item, [{ verdict: 'approved' }, { verdict: 'feedback', feedback: 'crashes on empty' }], 'also the colour is off');
    expect(bad.allApproved).toBe(false);
    expect(bad.feedback).toContain('Empty input');
    expect(bad.feedback).toContain('crashes on empty');
    expect(bad.feedback).toContain('colour is off');
  });

  it('never ships a walkthrough with unanswered cases', () => {
    const item = { review: { cases: [{ title: 'a', steps: [], expect: '' }, { title: 'b', steps: [], expect: '' }] } } as unknown as AttentionItem;
    expect(A.consolidate(item, [{ verdict: 'approved' }]).allApproved).toBe(false);
    expect(A.consolidate({ review: { cases: [] } } as unknown as AttentionItem, []).allApproved).toBe(false);
  });
});

describe('ticket writer (simulated)', () => {
  const scoper = new Scoper(new Store(tmpData()));
  const draft = (text: string) => scoper.draft({ text, projectId: 'default' });

  it('turns a customer report into a fix title', async () => {
    expect((await draft('customers keep saying the invoice PDF shows the wrong date when they are in a different timezone, can we fix it')).title)
      .toBe('Fix: invoice PDF shows the wrong date');
    expect((await draft('Customers in Europe say the checkout total shows $ instead of €, and the email is wrong')).title)
      .toBe('Fix: checkout total shows $ instead of €');
  });

  it('keeps feature requests as written', async () => {
    const d = await draft('add a dark mode toggle to settings');
    expect(d.title).toBe('Add a dark mode toggle to settings');
    expect(d.priority).toBe('medium');
  });

  it('titles stay under 70 characters and never end on a dangling word', async () => {
    const d = await draft('the export to spreadsheet button on the monthly reports screen does nothing when the user has more than one thousand rows in the table');
    expect(d.title.length).toBeLessThanOrEqual(70);
    expect(d.title).not.toMatch(/\s(a|the|of|to|in|when|and)$/i);
  });

  it('writes acceptance criteria and asks questions only for short inputs', async () => {
    const short = await draft('login is slow');
    expect(short.description).toContain('## Acceptance criteria');
    expect(short.questions.length).toBeGreaterThan(0);
    const answered = await scoper.draft({ text: 'login is slow', projectId: 'default', answers: [{ q: short.questions[0], a: 'Everyone on mobile' }] });
    expect(answered.questions).toHaveLength(0);
    expect(answered.description).toContain('Everyone on mobile');
  });

  it('flags urgent words', async () => {
    expect((await draft('checkout is down for everyone')).priority).toBe('urgent');
  });
});
