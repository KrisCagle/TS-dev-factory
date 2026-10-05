import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFactory, openItem, waitForStage, type TestFactory } from './helpers.js';

let f: TestFactory;
let api: ReturnType<typeof request>;
beforeEach(() => {
  f = makeFactory();
  api = request(f.app);
});
afterEach(async () => f.close());

describe('REST API', () => {
  it('GET /api/state returns everything the UI needs', async () => {
    const r = await api.get('/api/state').expect(200);
    expect(r.body).toMatchObject({ tickets: [], attention: [], factory: { paused: false } });
    expect(r.body.agents.map((a: { role: string }) => a.role)).toEqual(['planner', 'coder', 'tester', 'reviewer']);
    expect(r.body.settings.projects).toHaveLength(1);
    expect(r.body.stats).toHaveProperty('costUsd');
  });

  it('creates, edits and deletes tickets', async () => {
    const created = (await api.post('/api/tickets').send({ title: '  Add CSV export ', priority: 'high', labels: ['frontend'] }).expect(200)).body;
    expect(created).toMatchObject({ title: 'Add CSV export', priority: 'high', stage: 'backlog' });
    const edited = (await api.patch(`/api/tickets/${created.id}`).send({ title: 'Add CSV + XLSX export', stage: 'ready' }).expect(200)).body;
    expect(edited).toMatchObject({ title: 'Add CSV + XLSX export', stage: 'ready' });
    await api.delete(`/api/tickets/${created.id}`).expect(200);
    expect(f.store.ticket(created.id)).toBeUndefined();
  });

  it('validates input', async () => {
    await api.post('/api/tickets').send({ title: '   ' }).expect(400);
    await api.patch('/api/tickets/missing').send({ title: 'x' }).expect(404);
    await api.post('/api/tickets/missing/notes').send({ text: 'hi' }).expect(404);
    const t = f.store.createTicket({ title: 't' });
    await api.post(`/api/tickets/${t.id}/notes`).send({ text: '  ' }).expect(400);
    await api.post(`/api/tickets/${t.id}/reject`).send({}).expect(400);
  });

  it('refuses to move tickets around the pipeline by hand', async () => {
    const t = f.store.createTicket({ title: 't' });
    const r = await api.patch(`/api/tickets/${t.id}`).send({ stage: 'done' }).expect(400);
    expect(r.body.error).toMatch(/can't move/i);
  });

  it('approving something that is not waiting for you is a conflict, not a crash', async () => {
    const t = f.store.createTicket({ title: 't' });
    await api.post(`/api/tickets/${t.id}/approve`).send({}).expect(409);
    await api.post('/api/tickets/missing/approve').send({}).expect(404);
    await api.post('/api/attention/missing/resolve').send({ option: 'ship' }).expect(404);
  });

  it('runs a ticket end to end through the API', async () => {
    f.orch.start();
    const t = (await api.post('/api/tickets').send({ title: 'Ship me', stage: 'ready' }).expect(200)).body;
    await waitForStage(f, t.id, 'awaiting_approval');
    const item = openItem(f, t.id, 'merge:')!;
    await api.post(`/api/attention/${item.id}/resolve`).send({ option: 'ship' }).expect(200);
    await waitForStage(f, t.id, 'done');
    await api.post(`/api/attention/${item.id}/resolve`).send({ option: 'ship' }).expect(409);
    const report = (await api.get('/api/reports?range=day').expect(200)).body;
    expect(report.shipped.map((s: { key: string }) => s.key)).toContain(t.key);
    expect(report.markdown).toContain(t.key);
  });

  it('adds PM notes that agents will read', async () => {
    const t = f.store.createTicket({ title: 't' });
    await api.post(`/api/tickets/${t.id}/notes`).send({ text: 'Use the shared logger' }).expect(200);
    expect(f.store.ticket(t.id)!.notes.map((n) => n.text)).toEqual(['Use the shared logger']);
  });

  it('keeps secrets out of every response', async () => {
    await api.patch('/api/settings').send({ connectors: { github: { enabled: true, token: 'ghp_topsecret', repo: 'a/b', label: '' } } }).expect(200);
    const state = await api.get('/api/state').expect(200);
    expect(JSON.stringify(state.body)).not.toContain('topsecret');
  });

  it('loads demo tickets into the chosen project', async () => {
    const d = f.store.projects()[0];
    f.store.updateSettings({ projects: [d, { ...d, id: 'acme', keyPrefix: 'ACME' }] });
    await api.post('/api/demo').send({ projectId: 'acme' }).expect(200);
    const ts = f.store.tickets();
    expect(ts.length).toBeGreaterThan(3);
    expect(ts.every((t) => t.projectId === 'acme' && t.key.startsWith('ACME-'))).toBe(true);
  });

  it('pauses and resumes the factory', async () => {
    await api.post('/api/factory/pause').send({ paused: true }).expect(200);
    expect(f.orch.status().paused).toBe(true);
    await api.post('/api/factory/pause').send({ paused: false }).expect(200);
    expect(f.orch.status().paused).toBe(false);
  });

  it('drafts tickets with the ticket writer', async () => {
    const d = (await api.post('/api/scope').send({ text: 'add a dark mode toggle', projectId: 'default' }).expect(200)).body;
    expect(d.title).toBe('Add a dark mode toggle');
    expect(d.description).toContain('Acceptance criteria');
    await api.post('/api/scope').send({}).expect(400);
  });

  it('reads and saves house rules', async () => {
    const pid = f.store.projects()[0].id;
    await api.put(`/api/projects/${pid}/rules`).send({ text: '- Money is integer cents' }).expect(200);
    const r = (await api.get(`/api/projects/${pid}/rules`).expect(200)).body;
    expect(r.text).toContain('integer cents');
    expect(r.suggestions).toEqual([]);
  });

  it('saves house rules into the repo’s CLAUDE.md when the project has a repo', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
    const d = f.store.projects()[0];
    f.store.updateSettings({ projects: [{ ...d, repoPath: repo }] });
    const r = (await api.put(`/api/projects/${d.id}/rules`).send({ text: '# Rules\n- Tests first' }).expect(200)).body;
    expect(r.inRepo).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8')).toContain('Tests first');
  });

  it('builds the weekly report for one project', async () => {
    const r = (await api.get(`/api/reports?range=week&projectId=${f.store.projects()[0].id}`).expect(200)).body;
    expect(r.range).toBe('week');
    expect(r.markdown).toMatch(/^### Week of/);
  });
});

describe('code viewer safety', () => {
  it('reads files in a ticket’s worktree but nothing outside it', async () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
    execFileSync('git', ['init', '-q'], { cwd: wt });
    fs.mkdirSync(path.join(wt, 'src'));
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 1;\n');
    const secret = path.join(os.tmpdir(), `secret-${Date.now()}.txt`);
    fs.writeFileSync(secret, 'TOP SECRET');
    fs.symlinkSync(secret, path.join(wt, 'link.txt'));
    const t = f.store.createTicket({ title: 't' });
    f.store.updateTicket(t.id, { worktree: wt });

    const ok = (await api.get(`/api/tickets/${t.id}/file`).query({ path: 'src/a.ts' }).expect(200)).body;
    expect(ok.content).toContain('export const a');
    await api.get(`/api/tickets/${t.id}/file`).query({ path: '../../etc/passwd' }).expect(400);
    await api.get(`/api/tickets/${t.id}/file`).query({ path: secret }).expect(400);
    const viaLink = await api.get(`/api/tickets/${t.id}/file`).query({ path: 'link.txt' });
    expect(viaLink.status).toBe(400);
    expect(JSON.stringify(viaLink.body)).not.toContain('TOP SECRET');
    await api.get(`/api/tickets/${t.id}/file`).query({ path: '.git/config' }).expect(400);
    await api.get(`/api/tickets/${t.id}/file`).query({ path: 'src/nope.ts' }).expect(404);
  });

  it('serves artifacts only by id', async () => {
    const t = f.store.createTicket({ title: 't' });
    await api.get(`/api/tickets/${t.id}/artifacts/..%2F..%2Fdb.json`).expect(404);
  });
});
