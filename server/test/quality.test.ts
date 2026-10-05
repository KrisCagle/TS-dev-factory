import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import * as Q from '../src/quality.js';
import * as g from '../src/git.js';
import type { Ticket } from '../src/types.js';
import { makeFactory, openItem, waitFor, waitForStage, type TestFactory } from './helpers.js';

const DESC = `Export the filtered rows.

## Acceptance criteria
- [ ] An Export CSV button downloads the filtered rows
- [ ] The file has a header row
- [x] Commas and quotes are escaped

## Out of scope
- Excel export`;

describe('acceptance criteria', () => {
  it('reads the checklist under the heading and stops at the next one', () => {
    expect(Q.parseCriteria(DESC)).toEqual(['An Export CSV button downloads the filtered rows', 'The file has a header row', 'Commas and quotes are escaped']);
  });
  it('accepts numbered lists and bold headings', () => {
    expect(Q.parseCriteria('**Acceptance criteria**\n1. One\n2) Two\n\n**Notes**\n- not this')).toEqual(['One', 'Two']);
  });
  it('falls back to any checkboxes, and to nothing', () => {
    expect(Q.parseCriteria('Do it\n- [ ] works\n- plain bullet')).toEqual(['works']);
    expect(Q.parseCriteria('just a sentence')).toEqual([]);
  });
  it('marks criteria the Tester skipped as unproven', () => {
    const aligned = Q.alignProof(['Has a header row', 'Escapes quotes'], [{ criterion: 'has a header row!', status: 'proven', evidence: 'csv.test.ts' }]);
    expect(aligned).toEqual([
      { criterion: 'Has a header row', status: 'proven', evidence: 'csv.test.ts' },
      { criterion: 'Escapes quotes', status: 'unproven' },
    ]);
  });
});

describe('coverage gate', () => {
  it('passes small changes and blocks real drops', () => {
    expect(Q.coverageVerdict({ before: 80, after: 80.4 }, 0.5)).toMatchObject({ ok: true });
    expect(Q.coverageVerdict({ before: 80, after: 79.7 }, 0.5)).toMatchObject({ ok: true });
    const bad = Q.coverageVerdict({ before: 80, after: 78 }, 0.5);
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('80% to 78%');
  });
  it('skips projects that can’t measure coverage', () => {
    expect(Q.coverageVerdict(undefined, 0.5)).toMatchObject({ ok: true, skipped: true });
    expect(Q.coverageVerdict({ before: 80 }, 0.5)).toMatchObject({ ok: true, skipped: true });
  });
});

describe('safety score', () => {
  const diff = (files: string[], lines = 10) => files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n${'+x\n'.repeat(lines)}`).join('');
  const base: Partial<Ticket> = {
    iterations: 0,
    testReport: { passed: true, summary: '', failures: [], testsAdded: 2, criteria: [{ criterion: 'a', status: 'proven' }], coverage: { before: 80, after: 81 } },
    ci: { state: 'success', checks: [], updatedAt: 0, since: 0 },
    review: { verdict: 'approve', summary: '', comments: [] },
    diff: diff(['src/a.ts']),
  };
  const score = (over: Partial<Ticket> = {}, risky?: string[]) => Q.confidence({ ...base, ...over } as Ticket, { riskyPaths: risky });

  it('is high for a small, tested, green change', () => {
    const c = score();
    expect(c.level).toBe('high');
    expect(c.score).toBe(100);
    expect(c.reasons.every((r) => r.ok)).toBe(true);
  });
  it('drops for each thing worth a closer look, and says why', () => {
    const c = score({
      testReport: { ...base.testReport!, testsAdded: 0, criteria: [{ criterion: 'a', status: 'unproven' }] },
      diff: diff(['db/migrations/001.sql', 'src/auth/session.ts'], 200),
      iterations: 2,
    });
    expect(c.level).toBe('low');
    const bad = c.reasons.filter((r) => !r.ok).map((r) => r.text).join(' | ');
    expect(bad).toMatch(/No new tests/);
    expect(bad).toMatch(/1 of 1 acceptance criteria without proof/);
    expect(bad).toMatch(/sensitive files: db\/migrations\/001.sql, src\/auth\/session.ts/);
    expect(bad).toMatch(/Medium-sized change/);
    expect(bad).toMatch(/2 rework loops/);
  });
  it('uses the project’s own sensitive paths', () => {
    expect(score({ diff: diff(['src/pricing/engine.ts']) }, ['pricing/']).reasons.some((r) => /sensitive/.test(r.text))).toBe(true);
    expect(score({ diff: diff(['src/auth.ts']) }, ['pricing/']).reasons.some((r) => /sensitive/.test(r.text))).toBe(false);
  });
  it('never leaves 0–100', () => {
    const c = score({ testReport: { passed: false, summary: '', failures: [], criteria: [{ criterion: 'a', status: 'failed' }, { criterion: 'b', status: 'failed' }, { criterion: 'c', status: 'failed' }] }, ci: { state: 'failure', checks: [], updatedAt: 0, since: 0 }, diff: diff(['.env', 'payment.ts', 'auth.ts', 'migrations/x'], 900), iterations: 5, review: { verdict: 'approve', summary: '', comments: [{ severity: 'blocker', comment: 'x' }, { severity: 'major', comment: 'y' }] } });
    expect(c.score).toBe(0);
  });
});

let f: TestFactory;
afterEach(async () => f?.close());
const start = (...args: Parameters<typeof makeFactory>) => {
  f = makeFactory(...args);
  f.orch.start();
  return f;
};
const ready = (title = 'Add CSV export') => f.store.createTicket({ title, description: DESC, stage: 'ready' });
const ship = async (id: string) => {
  await waitForStage(f, id, 'awaiting_approval');
  f.orch.approve(id);
  return waitForStage(f, id, 'done');
};

describe('quality gates in the pipeline', () => {
  it('attaches proof per criterion and a safety score to the sign-off', async () => {
    start();
    const t = ready();
    const done = await waitForStage(f, t.id, 'awaiting_approval');
    expect(done.testReport!.criteria!.map((c) => c.status)).toEqual(['proven', 'proven', 'proven']);
    expect(done.testReport!.criteria![0].evidence).toBeTruthy();
    expect(done.testReport!.coverage!.after).toBeGreaterThan(0);
    expect(done.confidence!.level).toBe('high');
    expect(openItem(f, t.id, 'merge:')!.brief!.recommend).toMatch(/Walk the \d cases and ship/);
  });

  it('flags unproven criteria in the sign-off brief', async () => {
    start({ mock: { leavesUnproven: (_k, c) => c.includes('header row') } });
    const t = ready();
    await waitForStage(f, t.id, 'awaiting_approval');
    const brief = openItem(f, t.id, 'merge:')!.brief!.recommend;
    expect(brief).toContain('check this criterion by hand');
    expect(brief).toContain('The file has a header row');
    expect(f.store.ticket(t.id)!.confidence!.level).not.toBe('high');
  });

  it('sends unproven criteria back to the Coder when proof is required', async () => {
    let runs = 0;
    start({ settings: { quality: { requireProof: true, coverage: { enabled: true, maxDropPct: 0.5 }, smoke: true } }, mock: { leavesUnproven: (_k, c) => c.includes('header row') && ++runs < 2 } });
    const t = ready();
    const done = await waitForStage(f, t.id, 'awaiting_approval');
    expect(done.iterations).toBe(1);
    expect(f.store.logs(t.id).some((l) => /Acceptance criteria without proof/.test(l.text))).toBe(true);
    expect(done.testReport!.criteria!.every((c) => c.status === 'proven')).toBe(true);
  });

  it('sends a coverage drop back to the Coder', async () => {
    let n = 0;
    start({ mock: { coverageDrops: () => ++n === 1 } });
    const t = ready();
    const done = await waitForStage(f, t.id, 'awaiting_approval');
    expect(done.iterations).toBe(1);
    expect(f.store.logs(t.id).some((l) => /Coverage dropped/.test(l.text))).toBe(true);
  });

  it('lets a coverage drop through when the gate is off', async () => {
    start({ settings: { quality: { requireProof: false, coverage: { enabled: false, maxDropPct: 0.5 }, smoke: true } }, mock: { coverageDrops: () => true } });
    const t = ready();
    const done = await waitForStage(f, t.id, 'awaiting_approval');
    expect(done.iterations).toBe(0);
    expect(done.confidence!.reasons.some((r) => !r.ok && /Coverage dropped/.test(r.text))).toBe(true);
  });
});

describe('after shipping', () => {
  it('runs a smoke test and records the pass', async () => {
    start();
    const t = ready();
    await ship(t.id);
    const smoked = await waitFor(() => f.store.ticket(t.id)!.ship?.smoke?.state === 'passed' && f.store.ticket(t.id), { what: 'smoke pass' });
    expect(smoked.ship!.sha).toBeTruthy();
  });

  it('offers a one-click revert when the smoke test fails, and queues a redo', async () => {
    start({ mock: { smokePasses: () => false } });
    const t = ready();
    await ship(t.id);
    const item = await waitFor(() => openItem(f, t.id, 'smoke:'), { what: 'smoke failure in the inbox' });
    expect(item.options!.map((o) => o.id)).toEqual(['revert', 'fixforward', 'keep']);
    f.orch.resolve(item.id, { option: 'revert' });
    const reverted = await waitFor(() => f.store.ticket(t.id)!.ship?.reverted && f.store.ticket(t.id), { what: 'revert' });
    expect(reverted.ship!.reverted!.sha).toBeTruthy();
    const redo = await waitFor(() => f.store.tickets().find((x) => x.title.startsWith(`Redo ${t.key}`)), { what: 'redo ticket' });
    expect(redo.description).toContain('Why it was reverted');
    expect(redo.description).toContain('Acceptance criteria');
  });

  it('can open a fix-forward ticket instead', async () => {
    start({ mock: { smokePasses: () => false } });
    const t = ready();
    await ship(t.id);
    const item = await waitFor(() => openItem(f, t.id, 'smoke:'), { what: 'smoke failure' });
    f.orch.resolve(item.id, { option: 'fixforward' });
    const fix = f.store.tickets().find((x) => x.title === `Fix smoke test after ${t.key}`)!;
    expect(fix.priority).toBe('urgent');
    expect(fix.stage).toBe('ready');
    expect(f.store.ticket(t.id)!.ship!.reverted).toBeUndefined();
  });

  it('refuses to revert twice or to revert work that never shipped', async () => {
    start();
    const t = ready();
    await expect(f.orch.revert(t.id)).rejects.toThrow(/merged/);
    await ship(t.id);
    await f.orch.revert(t.id);
    await expect(f.orch.revert(t.id)).rejects.toThrow(/Already reverted/);
  });
});

describe('git helpers for revert (real git)', () => {
  const repo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revert-'));
    const run = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir }).toString().trim();
    run('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    run('add', '.');
    run('commit', '-qm', 'init');
    return { dir, run };
  };

  it('reverts a --no-ff merge commit on the base branch', async () => {
    const { dir, run } = repo();
    run('checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    run('commit', '-qam', 'change');
    run('checkout', '-q', 'main');
    await g.mergeBranch(dir, 'feature', 'Merge feature');
    const merge = run('rev-parse', 'HEAD');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('two\n');
    await g.revertCommit(dir, merge, 'Revert FAC-1');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    expect(run('log', '-1', '--format=%s')).toBe('Revert FAC-1');
  });

  it('runs smoke commands in a throwaway checkout and reports failures', async () => {
    const { dir } = repo();
    const wt = await g.tempWorktree(dir, 'main');
    try {
      expect(fs.readFileSync(path.join(wt.dir, 'a.txt'), 'utf8')).toBe('one\n');
      expect((await g.runShell(wt.dir, 'echo ok && exit 0')).code).toBe(0);
      const bad = await g.runShell(wt.dir, 'echo boom >&2; exit 3');
      expect(bad.code).toBe(3);
      expect(bad.output).toContain('boom');
      expect((await g.runShell(wt.dir, 'sleep 5', 100)).timedOut).toBe(true);
    } finally {
      await wt.remove();
    }
    expect(fs.existsSync(wt.dir)).toBe(false);
  });
});
