import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { answerFromRecord } from '../src/asker.js';
import { catchUp } from '../src/catchup.js';
import { Store } from '../src/store.js';
import type { Ticket } from '../src/types.js';
import { makeFactory, openItem, tmpData, waitFor, waitForStage, type TestFactory } from './helpers.js';

let f: TestFactory;
afterEach(async () => f?.close());
const start = (...args: Parameters<typeof makeFactory>) => {
  f = makeFactory(...args);
  f.orch.start();
  return f;
};

describe('hand-off to your editor', () => {
  it('take over pauses the agents; hand back goes straight to the Tester', async () => {
    start();
    const t = f.store.createTicket({ title: 'Edit me', stage: 'ready' });
    await waitForStage(f, t.id, 'awaiting_approval');
    f.orch.takeOver(t.id);
    const mine = await waitForStage(f, t.id, 'manual');
    expect(mine.manual?.from).toBe('awaiting_approval');
    expect(openItem(f, t.id)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 150));
    expect(f.store.ticket(t.id)!.stage).toBe('manual'); // agents leave it alone

    const roles: string[] = [];
    f.store.on('log', (l) => l.ticketId === t.id && /started$/.test(l.text) && roles.push(l.agent));
    f.orch.handBack(t.id, 'Fixed the copy on the button');
    await waitForStage(f, t.id, 'awaiting_approval');
    expect(roles[0]).toBe('tester');
    expect(roles).not.toContain('planner');
    expect(roles).not.toContain('coder');
    expect(f.store.ticket(t.id)!.notes.at(-1)!.text).toContain('Fixed the copy');
  });

  it('can take over a ticket while an agent is mid-run', async () => {
    start({ mock: { speed: 0.05 } });
    const t = f.store.createTicket({ title: 'Busy', stage: 'ready' });
    await waitForStage(f, t.id, ['planning', 'coding']);
    f.orch.takeOver(t.id);
    await waitForStage(f, t.id, 'manual');
    await new Promise((r) => setTimeout(r, 300));
    expect(f.store.ticket(t.id)!.stage).toBe('manual');
    expect(f.orch.status().running).not.toContain(t.id);
  });

  it('refuses nonsense hand-offs', async () => {
    start();
    const t = f.store.createTicket({ title: 'x' });
    expect(() => f.orch.handBack(t.id)).toThrow(/isn’t with you/);
    f.store.updateTicket(t.id, { stage: 'done' });
    expect(() => f.orch.takeOver(t.id)).toThrow(/shipped/);
  });
});

describe('dependencies and file overlap', () => {
  it('a ticket waits for the one it depends on to ship', async () => {
    start({ settings: { gates: { plan: false, merge: false } } });
    f.orch.setPaused(true);
    const a = f.store.createTicket({ title: 'Schema change', stage: 'ready' });
    const b = f.store.createTicket({ title: 'Use the new column', stage: 'ready' });
    f.store.updateTicket(b.id, { dependsOn: [a.id] });
    f.orch.setPaused(false);
    await waitFor(() => f.store.ticket(b.id)!.waitingOn, { what: 'b to be waiting' });
    expect(f.store.ticket(b.id)!.waitingOn).toMatchObject({ reason: 'dependency', keys: [a.key] });
    await waitForStage(f, b.id, 'done');
    const aDone = f.store.ticket(a.id)!.finishedAt!;
    const bStarted = f.store.logs(b.id).find((l) => /started$/.test(l.text))!.ts;
    expect(bStarted).toBeGreaterThanOrEqual(aDone);
    expect(f.store.ticket(b.id)!.waitingOn).toBeUndefined();
  });

  it('two tickets that change the same file never code at the same time', async () => {
    start({ mock: { planFiles: () => ['src/shared/money.ts'] }, settings: { gates: { plan: false, merge: false } } });
    const a = f.store.createTicket({ title: 'A', stage: 'ready' });
    const b = f.store.createTicket({ title: 'B', stage: 'ready' });
    let overlap = false;
    const busy = (id: string) => ['coding', 'testing', 'reviewing', 'ci'].includes(f.store.ticket(id)!.stage);
    const timer = setInterval(() => { if (busy(a.id) && busy(b.id)) overlap = true; }, 3);
    await waitForStage(f, a.id, 'done');
    await waitForStage(f, b.id, 'done');
    clearInterval(timer);
    expect(overlap).toBe(false);
    const waited = [a, b].some((t) => f.store.logs(t.id).some((l) => /Waiting: .* changing src\/shared\/money.ts/.test(l.text)));
    expect(waited).toBe(true);
  });

  it('rejects self-dependencies and loops over the API', async () => {
    f = makeFactory();
    const api = request(f.app);
    const a = f.store.createTicket({ title: 'a' });
    const b = f.store.createTicket({ title: 'b' });
    await api.patch(`/api/tickets/${a.id}`).send({ dependsOn: [a.id] }).expect(400);
    await api.patch(`/api/tickets/${a.id}`).send({ dependsOn: [b.id] }).expect(200);
    const r = await api.patch(`/api/tickets/${b.id}`).send({ dependsOn: [a.id] }).expect(400);
    expect(r.body.error).toMatch(/loop/);
    await api.patch(`/api/tickets/${b.id}`).send({ dependsOn: ['nope'] }).expect(400);
  });
});

describe('cost forecast', () => {
  it('asks before starting work forecast over your limit', async () => {
    start({ mock: { estimateUsd: () => 4.2 }, settings: { forecast: { approveAboveUsd: 3 } } });
    const t = f.store.createTicket({ title: 'Big one', stage: 'ready' });
    const parked = await waitForStage(f, t.id, 'awaiting_approval');
    expect(parked.gate).toBe('plan');
    const item = openItem(f, t.id, 'plan:')!;
    expect(item.title).toContain('$4.20');
    expect(item.brief!.recommend).toContain('$3.00 limit');
    f.orch.resolve(item.id, { option: 'approve' });
    const signoff = await waitForStage(f, t.id, 'awaiting_approval');
    expect(signoff.gate).toBe('merge');
  });

  it('learns from finished tickets and adjusts later forecasts', () => {
    const s = new Store(tmpData());
    const p = s.projects()[0].id;
    s.calibrate(p, { costUsd: 1, minutes: 10 }, { costUsd: 2, minutes: 10 });
    s.calibrate(p, { costUsd: 1, minutes: 10 }, { costUsd: 2, minutes: 20 });
    const c = s.calibration(p)!;
    expect(c.n).toBe(2);
    expect(c.costRatio).toBeCloseTo(2, 1);
    expect(c.timeRatio).toBeGreaterThan(1.2);
    // an absurd outlier can't swing it wildly
    s.calibrate(p, { costUsd: 1, minutes: 10 }, { costUsd: 500, minutes: 10 });
    expect(s.calibration(p)!.costRatio).toBeLessThanOrEqual(4);
  });

  it('shows the adjusted forecast after a couple of tickets', async () => {
    start({ mock: { estimateUsd: () => 1 } });
    const p = f.store.projects()[0].id;
    f.store.calibrate(p, { costUsd: 1, minutes: 10 }, { costUsd: 1.5, minutes: 10 });
    f.store.calibrate(p, { costUsd: 1, minutes: 10 }, { costUsd: 1.5, minutes: 10 });
    const t = f.store.createTicket({ title: 'x', stage: 'ready' });
    const done = await waitForStage(f, t.id, 'awaiting_approval');
    expect(done.plan!.estimate!.costUsd).toBe(1);
    expect(done.plan!.estimate!.adjustedCostUsd).toBe(1.5);
  });
});

describe('ask a ticket', () => {
  const t = {
    key: 'FAC-9', title: 'CSV export', stage: 'awaiting_approval', gate: 'merge', iterations: 2, costUsd: 0.84, tokens: 12000,
    plan: { summary: 'Add an export button', steps: [], risks: ['Large tables'], files: [], estimate: { size: 'M', costUsd: 0.7, minutes: 12 } },
    diff: 'diff --git a/src/export.ts b/src/export.ts\n+++ b/src/export.ts\n+a\n+b\n-c\n',
    testReport: { passed: true, summary: '42 pass', failures: [], coverage: { before: 80, after: 81 }, criteria: [{ criterion: 'Has headers', status: 'unproven' }] },
    review: { verdict: 'approve', summary: 'Fine', comments: [{ severity: 'nit', comment: 'rename x' }] },
    loops: { tests: 1, review: 1 }, notes: [],
  } as unknown as Ticket;

  it('answers the common questions from the record', () => {
    expect(answerFromRecord(t, 'Why did you change these files?')).toContain('src/export.ts');
    expect(answerFromRecord(t, "what's left?")).toMatch(/waiting for your sign-off[\s\S]*Has headers/);
    expect(answerFromRecord(t, 'do the tests pass?')).toContain('80% to 81%');
    expect(answerFromRecord(t, 'how much did it cost?')).toMatch(/\$0\.84[\s\S]*\$0\.70/);
    expect(answerFromRecord(t, 'why was it sent back?')).toContain('2 times (1× tests, 1× review)');
    expect(answerFromRecord(t, 'tell me a joke')).toContain('Try asking');
  });

  it('keeps the conversation on the ticket', async () => {
    f = makeFactory();
    const api = request(f.app);
    const x = f.store.createTicket({ title: 'x' });
    const r = (await api.post(`/api/tickets/${x.id}/ask`).send({ question: 'what is left?' }).expect(200)).body;
    expect(r.a).toContain('backlog');
    expect(f.store.ticket(x.id)!.chat).toHaveLength(1);
    await api.post(`/api/tickets/${x.id}/ask`).send({ question: ' ' }).expect(400);
  });
});

describe('while you were away', () => {
  it('summarises what happened since you left', async () => {
    start();
    const since = Date.now() - 1;
    const a = f.store.createTicket({ title: 'One', stage: 'ready' });
    await waitForStage(f, a.id, 'awaiting_approval');
    f.orch.approve(a.id);
    await waitForStage(f, a.id, 'done');
    const b = f.store.createTicket({ title: 'Two', stage: 'ready' });
    await waitForStage(f, b.id, 'awaiting_approval');
    const c = catchUp(f.store, since);
    expect(c.shipped.map((x) => x.key)).toEqual([a.key]);
    expect(c.needsYou.map((x) => x.ticketId)).toContain(b.id);
    expect(c.started.length).toBe(2);
    expect(c.spendUsd).toBeGreaterThan(0);
    expect(c.headline).toMatch(/1 shipped · 1 waiting on you/);
    expect(catchUp(f.store, Date.now() + 1000).quiet).toBe(false); // still something waiting on you
  });

  it('says so when it was quiet', () => {
    const s = new Store(tmpData());
    expect(catchUp(s, Date.now() - 1000)).toMatchObject({ quiet: true, headline: expect.stringContaining('All quiet') });
  });
});
