import { afterEach, describe, expect, it } from 'vitest';
import { makeFactory, openItem, waitFor, waitForStage, type TestFactory } from './helpers.js';

let f: TestFactory;
const start = (...args: Parameters<typeof makeFactory>) => {
  f = makeFactory(...args);
  f.orch.start();
  return f;
};
afterEach(async () => f?.close());

const ready = (title = 'Add CSV export', extra = {}) => f.store.createTicket({ title, stage: 'ready', ...extra });

describe('agent pipeline (simulated)', () => {
  it('takes a ready ticket through plan → code → test → review → CI to your sign-off', async () => {
    start();
    const t = ready();
    const stages = new Set<string>();
    f.store.on('ticket', (x) => x.id === t.id && stages.add(x.stage));
    const done = await waitForStage(f, t.id, 'awaiting_approval');
    expect([...stages]).toEqual(expect.arrayContaining(['planning', 'coding', 'testing', 'reviewing', 'ci', 'awaiting_approval']));
    expect(done.plan?.steps.length).toBeGreaterThan(0);
    expect(done.testReport?.passed).toBe(true);
    expect(done.review?.verdict).toBe('approve');
    expect(done.diff).toContain('diff --git');
    expect(done.ci?.state).toBe('success');
    const item = openItem(f, t.id, 'merge:');
    expect(item?.kind).toBe('review');
    expect(item?.review?.cases?.length).toBeGreaterThan(0);
  });

  it('ships when you approve every walkthrough case', async () => {
    start();
    const t = ready();
    await waitForStage(f, t.id, 'awaiting_approval');
    const item = openItem(f, t.id, 'merge:')!;
    f.orch.resolve(item.id, { verdicts: item.review!.cases!.map(() => ({ verdict: 'approved' as const })) });
    const shipped = await waitForStage(f, t.id, 'done');
    expect(shipped.finishedAt).toBeTruthy();
    expect(f.store.attentionItem(item.id)!.status).toBe('resolved');
    expect(f.store.attention().filter((a) => a.ticketId === t.id && a.status === 'open')).toHaveLength(0);
  });

  it('sends walkthrough feedback back to the Coder as a note', async () => {
    start();
    const t = ready();
    await waitForStage(f, t.id, 'awaiting_approval');
    const item = openItem(f, t.id, 'merge:')!;
    f.orch.resolve(item.id, { verdicts: [{ verdict: 'feedback', feedback: 'Button is the wrong colour' }] });
    await waitForStage(f, t.id, ['coding', 'testing', 'reviewing', 'ci']);
    expect(f.store.ticket(t.id)!.notes.at(-1)!.text).toContain('Button is the wrong colour');
    await waitForStage(f, t.id, 'awaiting_approval');
  });

  it('loops back to the Coder when tests fail, then continues', async () => {
    let runs = 0;
    start({ mock: { testsPass: () => ++runs > 1 } });
    const t = ready();
    const done = await waitForStage(f, t.id, 'awaiting_approval');
    expect(runs).toBe(2);
    expect(done.iterations).toBe(1);
  });

  it('loops back when the reviewer requests changes on the first review', async () => {
    start({ mock: { reviewRequestsChanges: (_k, first) => first } });
    const t = ready();
    const done = await waitForStage(f, t.id, 'awaiting_approval');
    expect(done.iterations).toBe(1);
    expect(done.review?.verdict).toBe('approve');
  });

  it('escalates to you when the rework limit is reached', async () => {
    start({ mock: { testsPass: () => false }, settings: { maxLoops: 2 } });
    const t = ready();
    await waitForStage(f, t.id, 'awaiting_approval');
    const item = await waitFor(() => openItem(f, t.id, 'escalate:'), { what: 'escalation' });
    expect(item.brief?.recommend).toBeTruthy();
    expect(f.store.ticket(t.id)!.iterations).toBeGreaterThanOrEqual(2);
  });

  it('sends red CI back to the Coder instead of to you', async () => {
    start({ mock: { ciPasses: () => false } });
    const t = ready();
    const seen: string[] = [];
    f.store.on('ticket', (x) => x.id === t.id && x.ci && seen.push(x.ci.state));
    const done = await waitForStage(f, t.id, 'awaiting_approval');
    expect(seen).toContain('failure');
    expect(done.iterations).toBe(1);
    expect(done.ci?.state).toBe('success');
  });

  it('waits for plan approval when the plan gate is on', async () => {
    start({ settings: { gates: { plan: true, merge: true } } });
    const t = ready();
    const parked = await waitForStage(f, t.id, 'awaiting_approval');
    expect(parked.gate).toBe('plan');
    const item = openItem(f, t.id, 'plan:')!;
    f.orch.resolve(item.id, { option: 'approve' });
    await waitForStage(f, t.id, 'coding');
    const signoff = await waitForStage(f, t.id, 'awaiting_approval');
    expect(signoff.gate).toBe('merge');
  });

  it('requires a note to send something back', async () => {
    start({ settings: { gates: { plan: true, merge: true } } });
    const t = ready();
    await waitForStage(f, t.id, 'awaiting_approval');
    const item = openItem(f, t.id, 'plan:')!;
    expect(() => f.orch.resolve(item.id, { option: 'sendback', text: '  ' })).toThrow(/note/i);
    expect(() => f.orch.resolve('nope', { option: 'approve' })).toThrow(/not found/i);
  });

  it('nudges a hung agent and carries on (watchdog)', async () => {
    let hung = false;
    start({ mock: { hangs: (_k, role) => role === 'coder' && !hung && (hung = true) } });
    const t = ready();
    await waitForStage(f, t.id, 'awaiting_approval');
    expect(hung).toBe(true);
    expect(f.store.logs(t.id).some((l) => /nudg|stalled|quiet|⏰/i.test(l.text))).toBe(true);
  });

  it('respects concurrency and pause', async () => {
    start({ settings: { concurrency: 1 } });
    f.orch.setPaused(true);
    const a = ready('A'), b = ready('B');
    await new Promise((r) => setTimeout(r, 200));
    expect(f.store.ticket(a.id)!.stage).toBe('ready');
    f.orch.setPaused(false);
    await waitFor(() => f.orch.status().running.length === 1, { what: 'one ticket running' });
    // with concurrency 1, both never run at the same time
    let overlap = false;
    const check = setInterval(() => { if (f.orch.status().running.length > 1) overlap = true; }, 5);
    await waitForStage(f, a.id, 'awaiting_approval');
    await waitForStage(f, b.id, 'awaiting_approval');
    clearInterval(check);
    expect(overlap).toBe(false);
  });

  it('works higher-priority tickets first', async () => {
    start({ settings: { concurrency: 1 } });
    f.orch.setPaused(true);
    const low = ready('low', { priority: 'low' });
    const urgent = ready('urgent', { priority: 'urgent' });
    f.orch.setPaused(false);
    await waitFor(() => f.orch.status().running[0], { what: 'first pick' });
    expect(f.orch.status().running[0]).toBe(urgent.id);
    expect(f.store.ticket(low.id)!.stage).toBe('ready');
  });

  it('cancel puts an in-flight ticket back in the backlog', async () => {
    start({ mock: { speed: 0.05 } });
    const t = ready();
    await waitForStage(f, t.id, ['planning', 'coding']);
    f.orch.cancel(t.id);
    await waitForStage(f, t.id, 'backlog');
    expect(f.orch.status().running).not.toContain(t.id);
  });

  it('stops a ticket that goes over its budget and asks you', async () => {
    start({ settings: { budgetPerTicketUsd: 0.05 }, mock: { testsPass: () => false } });
    const t = ready();
    const failed = await waitForStage(f, t.id, ['failed', 'awaiting_approval']);
    expect(failed.costUsd).toBeGreaterThan(0);
    await waitFor(() => f.store.attention().find((a) => a.ticketId === t.id && a.status === 'open'), { what: 'an inbox item' });
  });

  it('re-queues tickets that were mid-flight when the server stopped', async () => {
    start({ mock: { speed: 0.05 } });
    const t = ready();
    await waitForStage(f, t.id, ['planning', 'coding']);
    const file = (f.store as unknown as { file: string }).file;
    await f.close();
    const g = makeFactory({ dataFile: file });
    try {
      expect(g.store.ticket(t.id)!.stage).toBe('ready');
    } finally {
      await g.close();
    }
  });
});
