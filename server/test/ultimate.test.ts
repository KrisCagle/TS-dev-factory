import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createFactory } from '../src/app.js';
import { parseReport, resolvePluginDirs } from '../src/sessions.js';
import { toDrafts, waves } from '../src/pipelines.js';
import { groupFleet, outcome, parseTime } from '../src/scarif.js';
import { pickTransition } from '../src/connectors/jira.js';
import { projectIn } from '../src/assistant.js';
import { Store } from '../src/store.js';
import type { AttentionItem, TicketDraft } from '../src/types.js';
import { makeFactory, tmpData, waitFor, waitForStage, type TestFactory } from './helpers.js';

let f: TestFactory;
afterEach(async () => f?.close());

const open = (pred: (a: AttentionItem) => boolean) => f.store.attention().find((a) => a.status === 'open' && pred(a));

describe('session reports and plugins', () => {
  it('reads the last report line, with or without bold', () => {
    expect(parseReport('Did things.\n\nRESULT: Fixed the bug')).toEqual({ kind: 'result', text: 'Fixed the bug' });
    expect(parseReport('**REVIEW:** Check the new page')).toEqual({ kind: 'review', text: 'Check the new page' });
    expect(parseReport('QUESTION: one?\nBLOCKED: need a key')).toEqual({ kind: 'blocked', text: 'need a key' });
    expect(parseReport('no report here')).toBeUndefined();
  });

  it('finds a factory-assistant process plugin next to your projects', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    const plugin = path.join(home, 'Documents', 'factory-assistant', 'process-plugin');
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"factory-process"}');
    const mine = path.join(home, 'my-plugin');
    fs.mkdirSync(path.join(mine, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(mine, '.claude-plugin', 'plugin.json'), '{"name":"mine"}');
    expect(resolvePluginDirs(['~/my-plugin', '~/missing'], true, home)).toEqual([mine, plugin]);
    expect(resolvePluginDirs([], false, home)).toEqual([]);
  });
});

describe('sessions', () => {
  it('works, posts a review, and wraps up when you validate it', async () => {
    f = makeFactory();
    const s = f.sessions.start({ prompt: 'Add a CSV export to the reports page' });
    const review = await waitFor(() => open((a) => a.sessionId === s.id && a.kind === 'review'), { what: 'a review' });
    expect(review.review!.cases.length).toBeGreaterThan(0);
    const idle = await waitFor(() => { const x = f.store.session(s.id)!; return x.state === 'idle' && x.report ? x : undefined; }, { what: 'idle' });
    expect(idle.report!.kind).toBe('review');
    expect(idle.events.some((e) => e.kind === 'tool')).toBe(true);

    f.orch.resolve(review.id, { verdicts: review.review!.cases.map(() => ({ verdict: 'approved' as const })) });
    const after = await waitFor(() => { const x = f.store.session(s.id)!; return x.report?.kind === 'result' && x.state === 'idle' ? x : undefined; }, { what: 'result' });
    expect(after.turns).toBe(2);
    expect(after.events.filter((e) => e.kind === 'you').at(-1)!.text).toContain('every case passed');
  });

  it('sends review feedback back into the conversation', async () => {
    f = makeFactory();
    const s = f.sessions.start({ prompt: 'Fix the login copy' });
    const review = await waitFor(() => open((a) => a.sessionId === s.id && a.kind === 'review'));
    await waitFor(() => f.store.session(s.id)!.state === 'idle');
    f.orch.resolve(review.id, { verdicts: [{ verdict: 'feedback', feedback: 'Button text is still old' }, { verdict: 'approved' }] });
    await waitFor(() => f.store.session(s.id)!.turns === 2 && f.store.session(s.id)!.state !== 'running');
    const msg = f.store.session(s.id)!.events.filter((e) => e.kind === 'you').at(-1)!.text;
    expect(msg).toContain('wants changes');
    expect(msg).toContain('Button text is still old');
  });

  it('asks you for permission in ask mode, and stops cleanly when denied', async () => {
    f = makeFactory();
    f.store.updateSettings({ engine: { ...f.store.settings().engine, permissionMode: 'ask' } });
    const s = f.sessions.start({ prompt: 'Run the migrations' });
    const ask = await waitFor(() => open((a) => a.sessionId === s.id && a.kind === 'permission'), { what: 'permission' });
    expect(ask.body).toContain('npm test');
    expect(f.store.session(s.id)!.state).toBe('waiting');
    f.orch.resolve(ask.id, { option: 'deny' });
    const done = await waitFor(() => { const x = f.store.session(s.id)!; return x.report ? x : undefined; });
    expect(done.report!.kind).toBe('blocked');
  });

  it('posts decisions and relays your choice', async () => {
    f = makeFactory();
    const s = f.sessions.start({ prompt: 'Decide how to store the exports and build it' });
    const d = await waitFor(() => open((a) => a.sessionId === s.id && a.kind === 'decision'));
    expect(d.options![0].primary).toBe(true);
    await waitFor(() => f.store.session(s.id)!.state !== 'running');
    f.orch.resolve(d.id, { option: d.options![1].id });
    await waitFor(() => f.store.session(s.id)!.events.some((e) => e.kind === 'you' && e.text.includes(d.options![1].label)));
  });

  it('a question needs a typed answer', async () => {
    f = makeFactory();
    const s = f.sessions.start({ prompt: 'x' });
    const item = f.store.postAttention({ kind: 'question', key: `session:${s.id}:q`, sessionId: s.id, title: 'Which env?', options: [{ id: 'answer', label: 'Answer', needsText: true }] });
    expect(() => f.orch.resolve(item.id, { option: 'answer' })).toThrow(/note|answer/i);
  });

  it('marks sessions that were mid-turn as interrupted after a restart', () => {
    const file = tmpData();
    const a = new Store(file);
    a.createSession({ id: 's1', projectId: 'default', title: 'T', state: 'running', inbox: [], events: [], costUsd: 0, turns: 1, nudges: 0, createdAt: 1, updatedAt: 1 });
    a.flush();
    expect(new Store(file).session('s1')!.state).toBe('interrupted');
  });

  it('REST: start, message, stop, delete', async () => {
    f = makeFactory();
    const r = await request(f.app).post('/api/sessions').send({ prompt: 'what does the router do?' }).expect(200);
    const id = r.body.id;
    await waitFor(() => f.store.session(id)!.report);
    expect(f.store.session(id)!.report!.kind).toBe('result');
    await request(f.app).post(`/api/sessions/${id}/message`).send({ text: '' }).expect(400);
    await request(f.app).post(`/api/sessions/${id}/message`).send({ text: 'thanks — now add a test' }).expect(200);
    await request(f.app).post(`/api/sessions/${id}/stop`).expect(200);
    expect(f.store.session(id)!.state).toBe('stopped');
    await request(f.app).delete(`/api/sessions/${id}`).expect(200);
    await request(f.app).get(`/api/sessions`).expect(200).expect((res) => expect(res.body).toHaveLength(0));
  });
});

describe('pipelines', () => {
  it('orders tickets into waves and survives cycles', () => {
    const d = (id: string, dependsOn: string[] = []) => ({ id, dependsOn } as TicketDraft);
    expect(waves([d('a'), d('b', ['a']), d('c', ['a']), d('e', ['b', 'c'])])).toEqual([['a'], ['b', 'c'], ['e']]);
    expect(waves([d('x', ['y']), d('y', ['x'])]).flat().sort()).toEqual(['x', 'y']);
  });

  it('turns refs into ids and links stories', () => {
    const drafts = toDrafts([{ ref: 'T1', title: 'API', description: '', criteria: [], points: 4, stories: ['Export'] }, { ref: 'T2', title: 'UI', description: '', criteria: [], points: 20, dependsOn: ['T1', 'T9'] }], [{ id: 's1', title: 'Export reports', story: '', criteria: [] }]);
    expect(drafts[0].points).toBe(5);
    expect(drafts[1].points).toBe(13);
    expect(drafts[1].dependsOn).toEqual([drafts[0].id]);
    expect(drafts[0].storyIds).toEqual(['s1']);
  });

  it('runs from scope to done with your three validations', async () => {
    f = makeFactory({ settings: { gates: { plan: false, merge: false } } });
    f.orch.start();
    const p = f.pipelines.create({ scope: 'Let users export reports as CSV. Add a weekly email digest.' });
    const stories = await waitFor(() => open((a) => a.key === `pipeline:${p.id}:stories`), { what: 'stories gate' });
    expect(f.store.pipeline(p.id)!.stories.length).toBe(2);
    f.orch.resolve(stories.id, { option: 'approve' });

    const tickets = await waitFor(() => open((a) => a.key === `pipeline:${p.id}:tickets`), { what: 'tickets gate' });
    const pl = f.store.pipeline(p.id)!;
    expect(pl.tickets.length).toBe(4);
    // drop one ticket before approving
    f.pipelines.edit(p.id, { tickets: pl.tickets.slice(0, 3) });
    expect(f.store.attentionItem(tickets.id)!.status).toBe('dismissed'); // superseded by the edited summary
    f.orch.resolve(open((a) => a.key === `pipeline:${p.id}:tickets`)!.id, { option: 'approve' });

    const exec = await waitFor(() => { const x = f.store.pipeline(p.id)!; return x.tickets.every((t) => t.ticketId) && x.stage !== 'tickets' ? x : undefined; }, { what: 'board tickets' });
    const board = exec.tickets.map((d) => f.store.ticket(d.ticketId!)!);
    expect(board).toHaveLength(3);
    expect(board[1].dependsOn).toEqual([board[0].id]); // UI waits on its backend ticket
    expect(board.every((t) => t.pipelineId === p.id)).toBe(true);

    const validate = await waitFor(() => open((a) => a.key === `pipeline:${p.id}:validation`), { what: 'validation', timeout: 30_000 });
    expect(validate.review!.cases).toHaveLength(3);
    // one case fails → a follow-up ticket, back to execution
    f.orch.resolve(validate.id, { verdicts: [{ verdict: 'approved' }, { verdict: 'feedback', feedback: 'Header row is missing' }, { verdict: 'approved' }] });
    const follow = await waitFor(() => f.store.tickets().find((t) => t.pipelineId === p.id && t.labels.includes('follow-up')));
    expect(follow.description).toContain('Header row is missing');
    const again = await waitFor(() => open((a) => a.key === `pipeline:${p.id}:validation`), { what: 'second validation', timeout: 30_000 });
    f.orch.resolve(again.id, { verdicts: again.review!.cases.map(() => ({ verdict: 'approved' as const })) });
    await waitFor(() => f.store.pipeline(p.id)!.stage === 'done');
    expect(f.store.pipeline(p.id)!.status.validation).toBe('approved');
  });

  it('send back redrafts with your note; editing only while waiting', async () => {
    f = makeFactory();
    const p = f.pipelines.create({ scope: 'A settings page for notification preferences.' });
    await waitFor(() => f.store.pipeline(p.id)!.status.stories === 'waiting');
    expect(() => f.pipelines.edit(p.id, { tickets: [] })).toThrow(/wait for you/);
    expect(() => f.pipelines.sendBack(p.id, '')).toThrow(/change/);
    f.pipelines.sendBack(p.id, 'Include email and SMS');
    await waitFor(() => f.store.pipeline(p.id)!.status.stories === 'waiting' && f.store.pipeline(p.id)!.feedback.length === 1);
    expect(f.store.pipeline(p.id)!.stories[0].criteria.join(' ')).toContain('email and SMS');
  });

  it('routes small keyed tickets to Scarif (simulated) and tracks them to done', async () => {
    f = makeFactory({ settings: { gates: { plan: false, merge: false } } });
    f.orch.start();
    f.scarif.start();
    const p = f.pipelines.create({ scope: 'Add an audit log page.', createInJira: true, useScarif: true });
    await waitFor(() => f.store.pipeline(p.id)!.status.stories === 'waiting');
    f.pipelines.approve(p.id);
    await waitFor(() => f.store.pipeline(p.id)!.status.tickets === 'waiting');
    f.pipelines.approve(p.id);
    const pl = await waitFor(() => { const x = f.store.pipeline(p.id)!; return x.tickets.every((t) => t.ticketId) ? x : undefined; });
    expect(pl.tickets.every((t) => t.route === 'scarif' && t.jiraKey)).toBe(true);
    const first = f.store.ticket(pl.tickets[0].ticketId!)!;
    await waitFor(() => f.store.ticket(first.id)!.stage === 'remote' || f.store.ticket(first.id)!.stage === 'done');
    await waitForStage(f, first.id, 'done', 30_000);
    expect(f.store.ticket(first.id)!.remote!.status).toBe('completed');
  });
});

describe('Scarif', () => {
  it('groups your jobs under workers and parses its timestamps', () => {
    const items = [
      { id: 'w1', jira_key: 'APP-1', status: 'in_progress', enqueued_by: { id: 7 }, current_stage: { worker_session_id: 'd1' } },
      { id: 'w2', jira_key: 'APP-2', status: 'queued', enqueued_by: { id: 7 } },
      { id: 'w3', jira_key: 'OTHER-1', status: 'in_progress', enqueued_by: { id: 9 }, current_stage: { worker_session_id: 'd2' } },
      { id: 'w4', jira_key: 'APP-3', status: 'human_review', enqueued_by: { id: 9 }, current_stage: { worker_name: 'droid-b' } },
    ];
    const g = groupFleet(items, [{ id: 'd1', name: 'droid-a', status: 'busy' }, { id: 'd2', name: 'droid-c', status: 'busy' }, { id: 'd3', name: 'droid-b', status: 'busy' }], '7', 'https://s', new Set(['APP-3']));
    expect(g.workers.map((w) => w.name)).toEqual(['droid-a', 'droid-b']);
    expect(g.workers[1].jobs[0].needsHuman).toBe(true);
    expect(g.queued.map((j) => j.key)).toEqual(['APP-2']);
    expect(outcome('completed')).toBe('done');
    expect(outcome('human_review')).toBe('needs-you');
    expect(parseTime('2026-09-28 18:51:34 UTC')).toBe(Date.UTC(2026, 8, 28, 18, 51, 34));
  });

  it('live: enqueues with the CLI, tracks the job, asks you when a droid waits, and finishes the ticket', async () => {
    const statuses = ['in_progress', 'human_review', 'gone'];
    let call = 0;
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    const fakeFetch = (async (url: string) => {
      if (url.endsWith('/api/v2/me')) return json({ user: { id: 1 } });
      if (url.includes('/api/v2/worker_sessions')) return json({ worker_sessions: [{ id: 'd1', name: 'droid-1', status: 'busy' }] });
      if (url.includes('/api/v2/work_items?')) {
        const st = statuses[Math.min(call++, statuses.length - 1)];
        return json({ work_items: st === 'gone' ? [] : [{ id: '11111111-2222-3333-4444-555555555555', jira_key: 'APP-9', status: st, enqueued_by: { id: 1 }, current_stage: { worker_session_id: 'd1', worker_name: 'droid-1' } }] });
      }
      if (url.includes('/api/v2/work_items/')) return json({ id: '11111111-2222-3333-4444-555555555555', jira_key: 'APP-9', status: 'completed', pull_request_url: 'https://github.com/o/r/pull/5' });
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const ran: string[][] = [];
    process.env.FACTORY_SCARIF_BIN = process.execPath; // any existing file stands in for the CLI
    try {
      f = createFactory({
        dataFile: tmpData(), mode: 'live', serveWeb: false, schedules: false, pluginsDir: '',
        scarif: { fetch: fakeFetch, exec: async (_b, args) => { ran.push(args); return 'Enqueued 11111111-2222-3333-4444-555555555555'; } },
      });
      f.store.updateSettings({ scarif: { ...f.store.settings().scarif, enabled: true, url: 'https://scarif.test', token: 'tok' } });
      f.store.updateSettings({ projects: f.store.projects().map((p) => ({ ...p, githubRepo: 'o/r' })) });
      const t = f.store.createTicket({ title: 'Fix it', externalId: 'APP-9', source: 'jira', stage: 'backlog' });
      await f.scarif.enqueue(t.id);
      expect(ran[0]).toEqual(['enqueue', 'APP-9', '--repo', 'o/r']);
      expect(f.store.ticket(t.id)!.stage).toBe('remote');
      await waitFor(() => f.store.ticket(t.id)!.remote!.status === 'in_progress');
      await f.scarif.refresh();
      expect(open((a) => a.key.startsWith('scarif:'))!.url).toContain('/work_items/');
      await f.scarif.refresh();
      expect(f.store.ticket(t.id)!.stage).toBe('done');
      expect(f.store.ticket(t.id)!.prUrl).toContain('/pull/5');
      expect(open((a) => a.key.startsWith('scarif:'))).toBeUndefined();
      expect(f.scarif.fleet.state).toBe('ready');
      // the token never reaches the browser
      expect(JSON.stringify((await request(f.app).get('/api/state')).body)).not.toContain('tok"');
    } finally {
      delete process.env.FACTORY_SCARIF_BIN;
    }
  });

  it('explains what is missing before sending a ticket', async () => {
    f = createFactory({ dataFile: tmpData(), mode: 'live', serveWeb: false, schedules: false, pluginsDir: '' });
    const t = f.store.createTicket({ title: 'No key' });
    await expect(f.scarif.enqueue(t.id)).rejects.toThrow(/Turn Scarif on/);
    f.store.updateSettings({ scarif: { ...f.store.settings().scarif, enabled: true } });
    await expect(f.scarif.enqueue(t.id)).rejects.toThrow(/Jira key/);
  });
});

describe('Jira', () => {
  it('moves issues to your mapped status, else by category', () => {
    const tr = [
      { id: '1', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
      { id: '2', to: { name: 'Code Review', statusCategory: { key: 'indeterminate' } } },
      { id: '3', to: { name: 'Done', statusCategory: { key: 'done' } } },
    ];
    expect(pickTransition(tr, { status: 'code review', category: 'indeterminate' })!.id).toBe('2');
    expect(pickTransition(tr, { category: 'indeterminate' })!.id).toBe('1');
    expect(pickTransition(tr, { status: 'Nope', category: 'done' })!.id).toBe('3');
  });
});

describe('the assistant (simulated brain)', () => {
  it('answers status and queue questions', async () => {
    f = makeFactory();
    expect((await f.assistant.ask('what needs me?')).text).toMatch(/queue is clear/i);
    f.store.postAttention({ kind: 'decision', key: 'k', title: 'Pick a DB', options: [{ id: 'approve', label: 'Postgres', primary: true }] });
    expect((await f.assistant.ask("what's waiting on me")).text).toContain('Pick a DB');
    expect((await f.assistant.ask('status')).text).toMatch(/1 thing needs you/);
  });

  it('creates tickets, starts sessions and pipelines by voice', async () => {
    f = makeFactory();
    f.store.updateSettings({ projects: [...f.store.projects(), { ...f.store.projects()[0], id: 'wb', name: 'WingBuddies', keyPrefix: 'WB' }] });
    const a = await f.assistant.ask('New ticket for WingBuddies: add dark mode to the profile screen');
    expect(a.actions![0]).toMatch(/Created WB-1/);
    expect(f.store.tickets()[0].projectId).toBe('wb');
    const b = await f.assistant.ask('Start a session in WingBuddies to fix the flaky login test');
    expect(b.actions![0]).toMatch(/Started session/);
    expect(f.store.sessions()[0].projectId).toBe('wb');
    const c = await f.assistant.ask('Start a pipeline for a referral program with invite links');
    expect(c.actions![0]).toMatch(/Started pipeline/);
    expect(f.store.pipelines()).toHaveLength(1);
    expect(f.assistant.turns()).toHaveLength(6);
  });

  it('approves what is waiting', async () => {
    f = makeFactory();
    const s = f.sessions.start({ prompt: 'Decide on a cache and add it' });
    await waitFor(() => open((a) => a.sessionId === s.id && a.kind === 'decision'));
    const r = await f.assistant.ask('approve');
    expect(r.text).toMatch(/^Approved/);
    expect(f.store.attention().filter((a) => a.sessionId === s.id && a.kind === 'decision')[0].status).toBe('resolved');
  });

  it('matches projects by name or key prefix', () => {
    const ps = [{ name: 'EnergyRight', keyPrefix: 'ER' }, { name: 'VDCI', keyPrefix: 'VD' }] as never[];
    expect((projectIn('ask energyright to bump deps', ps, ps[1]) as { name: string }).name).toBe('EnergyRight');
    expect((projectIn('fix vd login', ps, ps[0]) as { name: string }).name).toBe('VDCI');
  });
});
