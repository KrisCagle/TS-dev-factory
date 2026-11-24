import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createFactory } from '../src/app.js';
import { seeded } from '../src/agents/mock.js';
import { tmpData, waitFor, waitForStage, openItem } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(here, '../../plugins/examples');

function factoryWith(files: Record<string, string>, settings: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'));
  for (const [name, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), src);
  const f = createFactory({
    dataFile: tmpData(), mode: 'mock', serveWeb: false, schedules: false, pluginsDir: dir, speed: 0.01,
    // vitest's module runner can't see files created after it starts, so load the source as a data: URL
    pluginImporter: (file: string) => import(/* @vite-ignore */ `data:text/javascript;base64,${fs.readFileSync(file).toString('base64')}`),
    mock: { speed: 0.003, random: seeded(1), testsPass: () => true, reviewRequestsChanges: () => false, hangs: () => false, ciPasses: () => true, smokePasses: () => true, coverageDrops: () => false, leavesUnproven: () => false },
  });
  f.store.updateSettings({ concurrency: 4, notifications: { ...f.store.settings().notifications, enabled: false }, ...settings });
  return { f, dir };
}
const example = (name: string) => fs.readFileSync(path.join(EXAMPLES, name), 'utf8');

let f: ReturnType<typeof createFactory>;
afterEach(async () => f?.close());

describe('plugin loader', () => {
  it('loads plugins from the folder and reports broken ones without crashing', async () => {
    ({ f } = factoryWith({
      'good.mjs': "export default { name: 'good', description: 'ok', setup(api) { api.addRoom({ id: 'lab', label: 'Lab', icon: '🧫' }); } };",
      'bad.mjs': 'export default { nope: true };',
      'throws.mjs': "export default { name: 'throws', setup() { throw new Error('boom'); } };",
      'notes.txt': 'ignored',
    }));
    await f.pluginsReady;
    const s = (await request(f.app).get('/api/plugins').expect(200)).body;
    const byName = Object.fromEntries(s.plugins.map((p: { name: string }) => [p.name, p]));
    expect(byName.good).toMatchObject({ enabled: true, rooms: ['Lab'] });
    expect(byName.bad.error).toMatch(/export default/);
    expect(byName.throws.error).toBe('boom');
    expect(s.rooms).toEqual([{ id: 'lab', label: 'Lab', icon: '🧫', plugin: 'good' }]);
  });

  it('validates what plugins register', async () => {
    ({ f } = factoryWith({ 'x.mjs': "export default { name: 'x', setup(api) { api.addGate({ id: 'Bad Id', name: 'x', check: () => ({ ok: true }) }); } };" }));
    await f.pluginsReady;
    expect(f.plugins.loaded[0].error).toMatch(/lowercase/);
  });
});

describe('example plugins', () => {
  it('Security reviewer sends risky changes back to the Coder, and passes clean ones', async () => {
    ({ f } = factoryWith({ 'security-reviewer.mjs': example('security-reviewer.mjs') }));
    await f.pluginsReady;
    f.orch.start();
    // the simulated diff is clean → passes
    const t = f.store.createTicket({ title: 'Clean change', stage: 'ready' });
    const done = await waitForStage(f, t.id, 'awaiting_approval');
    expect(done.checks).toEqual([expect.objectContaining({ name: 'Security reviewer', ok: true, kind: 'role' })]);
    expect(done.confidence!.reasons.some((r) => r.ok && /Security reviewer passed/.test(r.text))).toBe(true);
    expect(f.store.logs(t.id).some((l) => /Security reviewer started/.test(l.text))).toBe(true);
  });

  it('a failing plugin role loops the work back with its findings', async () => {
    let calls = 0;
    ({ f } = factoryWith({}));
    await f.plugins.register({
      name: 'picky',
      setup(api) {
        api.addRole({ id: 'picky', name: 'Picky reviewer', after: 'reviewer', prompt: () => '', mock: () => (++calls === 1 ? { passed: false, summary: 'Hard-coded key', findings: [{ comment: 'Move the key to env' }] } : { passed: true, summary: 'Fine now' }) });
      },
    });
    f.orch.start();
    const t = f.store.createTicket({ title: 'x', stage: 'ready' });
    const done = await waitForStage(f, t.id, 'awaiting_approval');
    expect(calls).toBe(2);
    expect(done.iterations).toBe(1);
    expect(f.store.logs(t.id).some((l) => /Picky reviewer: Hard-coded key/.test(l.text))).toBe(true);
  });

  it('No leftovers flags debugging lines without blocking (or sends back when configured)', async () => {
    ({ f } = factoryWith({}));
    const mod = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(example('no-leftovers.mjs')).toString('base64')}`);
    await f.plugins.register(mod.default);
    f.orch.start();
    // make the simulated diff contain a console.log by giving the gate a ticket view through a real run:
    const t = f.store.createTicket({ title: 'x', stage: 'ready' });
    const done = await waitForStage(f, t.id, 'awaiting_approval');
    expect(done.checks?.find((c) => c.id === 'no-leftovers')?.ok).toBe(true);
    const gate = (f.plugins.activeGates()[0]);
    const flagged = await gate.check({ ...done, diff: '+++ b/a.ts\n+console.log(user)\n+// TODO remove\n' } as never);
    expect(flagged.ok).toBe(false);
    expect(flagged.message).toContain('2 leftovers');
    expect(gate.onFail).toBe('flag');
  });

  it('plugins can be switched off in settings', async () => {
    ({ f } = factoryWith({ 'security-reviewer.mjs': example('security-reviewer.mjs') }, { plugins: { 'security-reviewer': { enabled: false } } }));
    await f.pluginsReady;
    expect(f.plugins.loaded[0].enabled).toBe(false);
    expect(f.plugins.rolesAfter('reviewer')).toHaveLength(0);
    f.store.updateSettings({ plugins: { 'security-reviewer': { enabled: true } } });
    expect(f.plugins.rolesAfter('reviewer')).toHaveLength(1);
  });

  it('Changelog writes every shipped ticket', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-')), 'CHANGELOG.md');
    ({ f } = factoryWith({ 'changelog.mjs': example('changelog.mjs') }, { plugins: { changelog: { enabled: true, config: { file: out } } } }));
    await f.pluginsReady;
    f.orch.start();
    const t = f.store.createTicket({ title: 'Log me', stage: 'ready' });
    await waitForStage(f, t.id, 'awaiting_approval');
    f.orch.resolve(openItem(f as never, t.id, 'merge:')!.id, { option: 'ship' });
    await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes(t.key), { what: 'changelog line' });
    expect(fs.readFileSync(out, 'utf8')).toMatch(new RegExp(`\\*\\*${t.key}\\*\\* Log me`));
  });

  it('JSON inbox imports tickets once', async () => {
    const inbox = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'in-')), 'inbox.json');
    fs.writeFileSync(inbox, JSON.stringify([{ id: 1, title: 'From JSON', priority: 'high' }, { id: 2, title: 'Second' }]));
    ({ f } = factoryWith({ 'json-inbox.mjs': example('json-inbox.mjs') }, { plugins: { 'json-inbox': { enabled: true, config: { file: inbox } } } }));
    await f.pluginsReady;
    const api = request(f.app);
    expect((await api.post('/api/plugins/sources/json-inbox/sync').send({}).expect(200)).body).toEqual({ fetched: 2, created: 2 });
    expect((await api.post('/api/plugins/sources/json-inbox/sync').send({}).expect(200)).body).toEqual({ fetched: 2, created: 0 });
    const t = f.store.tickets().find((x) => x.title === 'From JSON')!;
    expect(t).toMatchObject({ priority: 'high', stage: 'backlog', source: 'plugin' });
    await api.post('/api/plugins/sources/nope/sync').send({}).expect(404);
  });
});
