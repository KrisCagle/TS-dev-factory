import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ClaudeRunner, type AgentRunner, type RunResult } from './agents/runner.js';
import { MockRunner, mockDiff, type MockOptions } from './agents/mock.js';
import * as A from './attention.js';
import * as Q from './quality.js';
import { connectorFor, github } from './connectors/index.js';
import * as g from './git.js';
import type { HarvestService } from './harvest-service.js';
import { PLAN_SCHEMA, REVIEW_SCHEMA, TEST_SCHEMA, coderPrompt, plannerPrompt, reviewerPrompt, testerPrompt } from './prompts.js';
import type { Store } from './store.js';
import {
  PRIORITY_RANK,
  type Settings,
  type AgentRole, type AttentionItem, type ShipInfo, type CaseVerdict, type CiCheck, type CheckState, type Plan, type Review, type Stage, type TestReport, type Ticket,
} from './types.js';

type Phase = 'plan' | 'code';
const ACTIVE: Stage[] = ['planning', 'coding', 'testing', 'reviewing'];

class Cancelled extends Error {}
class Escalate extends Error {}
class Stuck extends Error {
  constructor(public role: AgentRole, public minutes: number, public nudges: number) {
    super(`${role} stopped responding for ${minutes} min after ${nudges} nudge(s)`);
  }
}

/** Live view of one agent run, for the watchdog. */
interface Activity {
  ticketId: string;
  role: AgentRole;
  attempt: AbortController;
  last: number;
  stalled: boolean;
}

export interface OrchestratorOptions {
  /** Simulated-agent knobs (speed, seeded randomness, forced outcomes). */
  mock?: MockOptions;
  /**
   * Scales the factory's own timers in simulated mode (scheduler, CI polling, watchdog).
   * Defaults to the mock speed, so a fast test run is fast end to end.
   */
  speed?: number;
}

export interface ResolveInput {
  option?: string;
  text?: string;
  verdicts?: CaseVerdict[];
  notes?: string;
}

export class Orchestrator {
  private running = new Map<string, AbortController>();
  private activity = new Map<string, Activity>();
  private ciPolled = new Map<string, number>();
  private mockCiPolls = new Map<string, number>();
  private claude = new ClaudeRunner();
  private mock: MockRunner;
  private speed: number;
  private random: () => number;
  private mockOpts: MockOptions;
  private timers: NodeJS.Timeout[] = [];
  paused = false;
  private shuttingDown = false;

  /** Extension points used by other services (previews, artifacts). */
  hooks: { rulesFor?: (projectId: string) => string; onFinished?: (ticketId: string) => void; afterTester?: (ticketId: string, cwd: string) => Promise<void>; afterReview?: (ticketId: string) => Promise<void> } = {};

  constructor(private store: Store, private harvest: HarvestService, opts: OrchestratorOptions = {}) {
    this.mock = new MockRunner(opts.mock);
    this.mockOpts = opts.mock ?? {};
    this.speed = opts.speed ?? opts.mock?.speed ?? 1;
    this.random = opts.mock?.random ?? Math.random;
    // Anything mid-flight when the server stopped goes back in the queue.
    for (const t of store.tickets()) {
      if (ACTIVE.includes(t.stage)) {
        store.updateTicket(t.id, { stage: 'ready', activeAgent: undefined });
        this.log(t.id, 'factory', 'status', 'Server restarted — ticket re-queued.');
      }
    }
  }

  start() {
    const ms = (n: number) => Math.max(20, Math.round(n * this.speed));
    this.timers.push(setInterval(() => this.tick(), ms(1500)));
    this.timers.push(setInterval(() => void this.ciTick(), ms(3000)));
    this.timers.push(setInterval(() => this.watchdogTick(), ms(5000)));
    this.reconcile();
  }

  stop() {
    this.shuttingDown = true;
    for (const t of this.timers) clearInterval(t);
    for (const ac of this.running.values()) ac.abort();
  }

  status() {
    return { running: [...this.running.keys()], paused: this.paused };
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.store.emit('factory', this.status());
  }

  /**
   * Settings as seen by one ticket: repo, branch, merge strategy and GitHub repo come from its project.
   */
  private ps(t: Ticket): Settings {
    const s = this.store.settings();
    const p = this.store.project(t.projectId);
    return {
      ...s,
      repoPath: p.repoPath,
      baseBranch: p.baseBranch || 'main',
      worktreesDir: p.worktreesDir,
      mergeStrategy: p.mergeStrategy,
      connectors: p.githubRepo ? { ...s.connectors, github: { ...s.connectors.github, repo: p.githubRepo } } : s.connectors,
    };
  }

  private get runner(): AgentRunner {
    return this.store.settings().mode === 'live' ? this.claude : this.mock;
  }

  private log(ticketId: string, agent: AgentRole | 'pm' | 'factory', kind: 'status' | 'text' | 'tool' | 'result' | 'error' | 'pm', text: string) {
    this.store.log({ ticketId, agent, kind, text });
  }

  // ------------------------------------------------------------------ scheduling
  private tick() {
    if (this.paused) return;
    const { concurrency } = this.store.settings();
    if (this.running.size >= concurrency) return;
    const queue = this.store
      .tickets()
      .filter((t) => t.stage === 'ready' && !this.running.has(t.id))
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.order - b.order);
    for (const t of queue.slice(0, concurrency - this.running.size)) {
      void this.pipeline(t.id, t.plan && !this.store.agent('planner').enabled ? 'code' : 'plan');
    }
  }

  // ------------------------------------------------------------------ PM actions
  approve(id: string, note?: string) {
    const t = this.store.ticket(id);
    if (!t) throw Object.assign(new Error('Ticket not found'), { status: 404 });
    if (t.stage !== 'awaiting_approval') throw Object.assign(new Error('Ticket is not waiting for approval'), { status: 409 });
    if (note) this.addNote(id, note);
    this.store.closeAttentionFor(id);
    void this.harvest.stopIfRunning(id);
    this.log(id, 'pm', 'pm', `Approved ${t.gate === 'plan' ? 'the plan' : 'the change'}${note ? `: ${note}` : ''}`);
    if (t.gate === 'plan') void this.pipeline(id, 'code');
    else void this.finalize(id);
  }

  reject(id: string, feedback: string) {
    const t = this.store.ticket(id);
    if (!t) throw Object.assign(new Error('Ticket not found'), { status: 404 });
    if (t.stage !== 'awaiting_approval') throw Object.assign(new Error('Ticket is not waiting for approval'), { status: 409 });
    this.addNote(id, feedback);
    this.store.closeAttentionFor(id);
    void this.harvest.stopIfRunning(id);
    this.store.updateTicket(id, { iterations: 0 });
    this.log(id, 'pm', 'pm', `Sent back: ${feedback}`);
    void this.pipeline(id, t.gate === 'plan' ? 'plan' : 'code');
  }

  cancel(id: string) {
    const ac = this.running.get(id);
    this.store.closeAttentionFor(id);
    if (ac) ac.abort();
    else this.store.updateTicket(id, { stage: 'backlog', activeAgent: undefined, gate: undefined });
  }

  retry(id: string) {
    this.store.closeAttentionFor(id);
    this.store.updateTicket(id, { stage: 'ready', error: undefined, gate: undefined });
  }

  addNote(id: string, text: string) {
    const t = this.store.ticket(id);
    if (!t) return;
    this.store.updateTicket(id, { notes: [...t.notes, { id: randomUUID(), text, ts: Date.now() }] });
  }

  /** The PM answered something in the inbox. */
  resolve(itemId: string, input: ResolveInput) {
    const item = this.store.attentionItem(itemId);
    if (!item) throw Object.assign(new Error('Item not found'), { status: 404 });
    if (item.status === 'held') throw Object.assign(new Error(item.heldReason ?? 'This item is on hold'), { status: 409 });
    if (item.status !== 'open') throw Object.assign(new Error('Already answered'), { status: 409 });
    const t = item.ticketId ? this.store.ticket(item.ticketId) : undefined;
    const option = input.option;
    const opt = item.options?.find((o) => o.id === option);
    if (opt?.needsText && !input.text?.trim()) throw Object.assign(new Error('Add a note for the agents first.'), { status: 400 });

    const done = (patch: Partial<AttentionItem['resolution']> = {}) =>
      this.store.updateAttention(item.id, { status: 'resolved', resolution: { option, text: input.text, verdicts: input.verdicts, notes: input.notes, at: Date.now(), ...patch } });

    if (!t) {
      done();
      return;
    }
    const kind = item.key.split(':')[0];

    switch (kind) {
      case 'plan':
        done();
        if (option === 'approve') this.approve(t.id, input.text);
        else this.reject(t.id, input.text!.trim());
        return;

      case 'merge': {
        // A walkthrough answer: every case approved → ship; otherwise the feedback goes back.
        if (input.verdicts) {
          const { allApproved, feedback } = A.consolidate(item, input.verdicts, input.notes);
          done({ option: allApproved ? 'ship' : 'sendback' });
          if (allApproved) this.approve(t.id);
          else this.reject(t.id, feedback || 'PM requested changes.');
          return;
        }
        done();
        if (option === 'ship') this.approve(t.id, input.text);
        else this.reject(t.id, input.text!.trim());
        return;
      }

      case 'escalate':
        done();
        if (option === 'ship') this.approve(t.id, input.text);
        else if (option === 'backlog') this.park(t.id);
        else this.reject(t.id, input.text!.trim());
        return;

      case 'error':
      case 'stuck':
        done();
        if (input.text?.trim()) this.addNote(t.id, input.text.trim());
        if (option === 'retry') this.retry(t.id);
        else this.park(t.id);
        return;

      case 'smoke':
        done();
        if (option === 'revert') {
          void this.revert(t.id, { redo: true, note: input.text }).catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            this.log(t.id, 'factory', 'error', `Revert failed: ${msg}`);
            this.store.postAttention(A.failure(t, `Revert failed: ${msg}`));
          });
        } else if (option === 'fixforward') {
          const fix = this.store.createTicket({
            title: `Fix smoke test after ${t.key}`,
            description: `The smoke test failed right after ${t.key} (“${t.title}”) shipped.\n\n\`\`\`\n${t.ship?.smoke?.output ?? ''}\n\`\`\`\n\n## Acceptance criteria\n- [ ] The smoke test passes on the base branch\n- [ ] ${t.title} still works`,
            priority: 'urgent',
            projectId: t.projectId,
            stage: 'ready',
          });
          this.log(t.id, 'pm', 'pm', `Fix-forward ticket ${fix.key} created.`);
        } else {
          this.log(t.id, 'pm', 'pm', 'Smoke failure ignored.');
        }
        return;

      case 'ciwait':
        done();
        if (option === 'skip') {
          this.log(t.id, 'pm', 'pm', 'Skipped the CI wait.');
          this.ciSettled(t.id, 'none', t.ci?.checks ?? []);
        }
        return;

      default:
        done();
    }
  }

  // ------------------------------------------------------------------ after shipping: smoke test + revert
  /** Run the project's smoke command on the freshly updated base branch. */
  async smoke(id: string) {
    const t = this.store.ticket(id);
    if (!t?.ship) return;
    const s = this.ps(t);
    const project = this.store.project(t.projectId);
    const setSmoke = (smoke: NonNullable<Ticket['ship']>['smoke']) => this.store.updateTicket(id, { ship: { ...this.store.ticket(id)!.ship!, smoke } })!;
    if (s.mode === 'live' && !project.smokeCommand) {
      setSmoke({ state: 'skipped', output: 'No smoke command set for this project.', at: Date.now() });
      return;
    }
    setSmoke({ state: 'running', at: Date.now() });
    this.log(id, 'factory', 'status', `🧯 Running the smoke test on ${s.baseBranch}…`);
    let result: { code: number; output: string };
    if (s.mode === 'mock') {
      await new Promise((r) => setTimeout(r, 2500 * this.speed));
      const pass = this.mockOpts.smokePasses ? this.mockOpts.smokePasses(t.key) : this.random() > 0.1;
      result = pass
        ? { code: 0, output: '✓ 42 tests passed\n✓ build ok' }
        : { code: 1, output: `FAIL src/features/${t.key.toLowerCase()}.test.ts\n  ● handles a signed-out user\n    TypeError: Cannot read properties of undefined (reading 'id')\n✗ 1 failed, 41 passed` };
    } else {
      const ref = s.mergeStrategy === 'local-merge' ? s.baseBranch : await g.latestBase(s.repoPath, s.baseBranch);
      const wt = await g.tempWorktree(s.repoPath, ref);
      try {
        result = await g.runShell(wt.dir, project.smokeCommand!);
      } finally {
        await wt.remove();
      }
    }
    if (result.code === 0) {
      setSmoke({ state: 'passed', output: result.output.slice(-2000), at: Date.now() });
      this.log(id, 'factory', 'status', '✅ Smoke test passed after shipping.');
      return;
    }
    const e = setSmoke({ state: 'failed', output: result.output.slice(-4000), at: Date.now() });
    this.log(id, 'factory', 'error', `🧯 Smoke test failed after shipping ${t.key}.`);
    this.store.postAttention(A.smokeFailed(e, result.output));
    this.store.emit('notify', { event: 'failed', ticketId: id, title: `🧯 Smoke test failed after ${t.key} shipped`, body: 'Revert it with one click from your inbox.' });
  }

  /** Undo a shipped ticket: a revert commit (local) or a revert pull request. Optionally queue a redo. */
  async revert(id: string, opts: { redo?: boolean; note?: string } = {}) {
    const t = this.store.ticket(id);
    if (!t) throw Object.assign(new Error('Ticket not found'), { status: 404 });
    if (!t.ship?.sha) throw Object.assign(new Error('Only tickets the factory merged can be reverted here.'), { status: 409 });
    if (t.ship.reverted) throw Object.assign(new Error('Already reverted.'), { status: 409 });
    const s = this.ps(t);
    let reverted: NonNullable<NonNullable<Ticket['ship']>['reverted']>;
    if (s.mode === 'mock') {
      reverted = { at: Date.now(), sha: `revert-${t.key.toLowerCase()}`, prUrl: t.ship.how === 'simulated' && t.prNumber ? `https://github.com/example/app/pull/${t.prNumber + 1}` : undefined, note: opts.note };
    } else if (t.ship.how === 'local-merge') {
      const sha = await g.revertCommit(s.repoPath, t.ship.sha, `Revert ${t.key}: ${t.title}${opts.note ? `\n\n${opts.note}` : ''}`);
      reverted = { at: Date.now(), sha, note: opts.note };
    } else {
      const base = await g.latestBase(s.repoPath, s.baseBranch);
      const wt = await g.tempWorktree(s.repoPath, base);
      try {
        const branch = `factory/revert-${t.key.toLowerCase()}`;
        await g.git(wt.dir, 'checkout', '-b', branch);
        const sha = await g.revertCommit(wt.dir, t.ship.sha, `Revert ${t.key}: ${t.title}`);
        await g.pushBranch(wt.dir, branch);
        const pr = await github.createPR(s, branch, s.baseBranch, `Revert ${t.key}: ${t.title}`, `Reverts ${t.prUrl ?? t.key}.${opts.note ? `\n\n${opts.note}` : ''}\n\n_Opened by AI Dev Factory_`);
        reverted = { at: Date.now(), sha, prUrl: pr.url, note: opts.note };
      } finally {
        await wt.remove();
      }
    }
    this.store.updateTicket(id, { ship: { ...t.ship, reverted } });
    this.store.closeAttentionFor(id, 'smoke');
    this.log(id, 'pm', 'pm', `↩️ Reverted${reverted.prUrl ? ` — ${reverted.prUrl}` : ''}.`);
    if (opts.redo) {
      const smoke = t.ship.smoke?.state === 'failed' ? `\n\n## Why it was reverted\nThe smoke test failed right after it shipped:\n\`\`\`\n${t.ship.smoke.output ?? ''}\n\`\`\`` : '';
      const redo = this.store.createTicket({
        title: `Redo ${t.key}: ${t.title}`.slice(0, 120),
        description: `${t.description}${smoke}`,
        priority: t.priority === 'low' ? 'medium' : t.priority,
        labels: t.labels,
        projectId: t.projectId,
        stage: 'ready',
      });
      for (const n of t.notes) this.addNote(redo.id, n.text);
      this.log(redo.id, 'factory', 'status', `Redo of ${t.key} after it was reverted.`);
      return { reverted, redo };
    }
    return { reverted };
  }

  private park(id: string) {
    this.hooks.onFinished?.(id);
    this.store.closeAttentionFor(id);
    void this.harvest.stopIfRunning(id);
    this.store.updateTicket(id, { stage: 'backlog', gate: undefined, activeAgent: undefined, error: undefined });
    this.log(id, 'pm', 'pm', 'Parked in backlog.');
  }

  // ------------------------------------------------------------------ pipeline
  private async pipeline(id: string, from: Phase) {
    if (this.running.has(id)) return;
    const ac = new AbortController();
    this.running.set(id, ac);
    this.store.emit('factory', this.status());
    const s = this.store.settings();
    const set = (patch: Partial<Ticket>) => this.store.updateTicket(id, patch)!;

    try {
      let t = set({ stage: from === 'plan' ? 'planning' : 'coding', gate: undefined, error: undefined, startedAt: this.store.ticket(id)!.startedAt ?? Date.now() });
      const cwd = await this.workspace(t);

      // ---- plan
      if (from === 'plan' && this.store.agent('planner').enabled) {
        await this.sync(t, 'planning', 'Picked up by the factory. Planning…');
        const r = await this.runAgent(id, 'planner', plannerPrompt(t), cwd, ac.signal, PLAN_SCHEMA);
        const plan = normalizePlan(r.structured, r.text);
        t = set({ plan });
        this.log(id, 'planner', 'result', `Plan: ${plan.summary}`);
        if (s.gates.plan) {
          t = set({ stage: 'awaiting_approval', gate: 'plan', activeAgent: undefined });
          this.store.postAttention(A.planGate(t));
          this.log(id, 'factory', 'status', 'Plan ready — waiting for PM approval.');
          return;
        }
      }

      // ---- code / test / review loop
      for (;;) {
        this.checkBudget(id);
        t = set({ stage: 'coding' });
        if (t.iterations === 0) await this.sync(t, 'coding', 'Implementation started.');
        await this.runAgent(id, 'coder', coderPrompt(t), cwd, ac.signal);
        await this.commit(t, cwd, `${t.key}: ${t.title}${t.iterations ? ` (rev ${t.iterations})` : ''}`);

        if (this.store.agent('tester').enabled) {
          t = set({ stage: 'testing' });
          const r = await this.runAgent(id, 'tester', testerPrompt(t), cwd, ac.signal, TEST_SCHEMA);
          let report = normalizeTest(r.structured, r.text);
          report = { ...report, criteria: Q.alignProof(Q.parseCriteria(t.description), report.criteria) };
          // a criterion that demonstrably doesn't work is a failing test, whatever the suite says
          const broken = report.criteria?.filter((c) => c.status === 'failed') ?? [];
          if (report.passed && broken.length) {
            report = { ...report, passed: false, failures: [...report.failures, ...broken.map((c) => `Acceptance criterion not met: ${c.criterion}${c.evidence ? ` (${c.evidence})` : ''}`)] };
          }
          t = set({ testReport: report });
          await this.hooks.afterTester?.(id, cwd).catch(() => undefined);
          await this.commit(t, cwd, `${t.key}: tests`);
          this.log(id, 'tester', 'result', `${report.passed ? '✅ Tests passed' : '❌ Tests failed'} — ${report.summary}`);
          if (!report.passed) {
            this.loopBack(id, 'Tests failed');
            continue;
          }
          // ---- quality gates: coverage and proof of every acceptance criterion
          const q = s.quality;
          const cov = Q.coverageVerdict(report.coverage, q.coverage.maxDropPct);
          if (!cov.skipped) this.log(id, 'tester', 'status', cov.message);
          if (q.coverage.enabled && !cov.ok) {
            t = set({ testReport: { ...report, passed: false, summary: cov.message, failures: [`${cov.message} Add tests for the code you changed.`] } });
            this.loopBack(id, 'Coverage dropped');
            continue;
          }
          const missing = Q.unproven(t);
          if (missing.length) this.log(id, 'tester', 'status', `⚠️ ${missing.length} acceptance criteri${missing.length === 1 ? 'on has' : 'a have'} no proof: ${missing.map((c) => c.criterion).join('; ')}`);
          if (q.requireProof && missing.length) {
            t = set({ testReport: { ...report, passed: false, summary: 'Some acceptance criteria have no test proving them.', failures: missing.map((c) => `Add a test that proves: ${c.criterion}`) } });
            this.loopBack(id, 'Acceptance criteria without proof');
            continue;
          }
        }

        if (this.store.agent('reviewer').enabled) {
          t = set({ stage: 'reviewing' });
          const diff = await this.diff(t, cwd);
          t = set({ diff });
          const r = await this.runAgent(id, 'reviewer', reviewerPrompt(t, diff), cwd, ac.signal, REVIEW_SCHEMA);
          const review = normalizeReview(r.structured, r.text);
          t = set({ review });
          this.log(id, 'reviewer', 'result', `${review.verdict === 'approve' ? '✅ Approved' : '🔁 Changes requested'} — ${review.summary}`);
          if (review.verdict === 'request_changes') {
            this.loopBack(id, 'Reviewer requested changes');
            continue;
          }
          await this.hooks.afterReview?.(id).catch(() => undefined);
        }
        break;
      }

      t = set({ diff: await this.diff(this.store.ticket(id)!, cwd), activeAgent: undefined });

      // ---- CI gate: open/update the PR and hold sign-off until checks are green
      if (this.ciApplies(this.store.ticket(id)!)) {
        await this.openOrUpdatePR(id);
        t = set({ stage: 'ci', ci: { state: 'pending', checks: [], since: Date.now(), updatedAt: Date.now() } });
        t = this.score(id);
        this.ciPolled.delete(id);
        this.mockCiPolls.delete(id);
        if (s.gates.merge) this.store.postAttention(A.signoff(t, 'Waiting for CI checks to pass'));
        this.log(id, 'factory', 'status', `Waiting for CI on ${t.prNumber ? `PR #${t.prNumber}` : 'the branch'}…`);
        return;
      }

      t = this.score(id);
      if (s.gates.merge) {
        t = set({ stage: 'awaiting_approval', gate: 'merge' });
        this.store.postAttention(A.signoff(t));
        this.log(id, 'factory', 'status', 'Ready for PM sign-off.');
        await this.sync(t, 'awaiting_approval', 'Implementation complete and reviewed — awaiting PM sign-off.');
      } else {
        this.running.delete(id);
        await this.finalize(id);
      }
    } catch (err) {
      const t = this.store.ticket(id);
      if (this.shuttingDown || !t) {
        // leave the stage alone — the constructor re-queues it on next start
      } else if (err instanceof Cancelled || ac.signal.aborted) {
        set({ stage: 'backlog', activeAgent: undefined });
        this.log(id, 'pm', 'pm', 'Cancelled by PM — moved back to backlog.');
      } else if (err instanceof Escalate) {
        this.score(id);
        const e = set({ stage: 'awaiting_approval', gate: 'merge', activeAgent: undefined });
        this.store.postAttention(A.escalation(e, err.message));
        this.log(id, 'factory', 'status', `Escalated to PM: ${err.message}`);
      } else if (err instanceof Stuck) {
        const e = set({ stage: 'failed', activeAgent: undefined, error: err.message });
        this.store.postAttention(A.stuck(e, this.store.agent(err.role).name, err.minutes, err.nudges));
        this.log(id, 'factory', 'error', `⏰ Watchdog gave up: ${err.message}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        const e = set({ stage: 'failed', activeAgent: undefined, error: msg });
        this.store.postAttention(A.failure(e, msg));
        this.log(id, 'factory', 'error', msg);
      }
    } finally {
      this.running.delete(id);
      this.store.emit('factory', this.status());
    }
  }

  /** Work out the safety score for the sign-off and keep it on the ticket. */
  private score(id: string) {
    const t = this.store.ticket(id)!;
    return this.store.updateTicket(id, { confidence: Q.confidence(t, this.store.project(t.projectId), this.store.settings().quality) })!;
  }

  private loopBack(id: string, reason: string) {
    const t = this.store.ticket(id)!;
    const iterations = t.iterations + 1;
    this.store.updateTicket(id, { iterations });
    if (iterations >= this.store.settings().maxLoops) {
      throw new Escalate(`${reason} after ${iterations} loops — needs a PM decision.`);
    }
    this.log(id, 'factory', 'status', `${reason} — back to the Coder (loop ${iterations}).`);
  }

  private checkBudget(id: string) {
    const s = this.store.settings();
    const t = this.store.ticket(id)!;
    if (s.mode === 'live' && s.budgetPerTicketUsd > 0 && t.costUsd >= s.budgetPerTicketUsd) {
      throw new Escalate(`Budget of $${s.budgetPerTicketUsd} reached ($${t.costUsd.toFixed(2)} spent).`);
    }
  }

  /**
   * Run one agent with the watchdog attached. A run that goes quiet is aborted and
   * restarted with a nudge; after `maxNudges` it's handed to the PM as stuck.
   */
  private async runAgent(id: string, role: AgentRole, prompt: string, cwd: string, signal: AbortSignal, schema?: Record<string, unknown>): Promise<RunResult> {
    const agent = this.store.agent(role);
    const s = this.store.settings();
    const maxNudges = s.watchdog.enabled ? s.watchdog.maxNudges : 0;
    const rules = this.hooks.rulesFor?.(this.store.ticket(id)!.projectId);
    if (rules) prompt = `## House rules for this project — follow them\n${rules}\n\n${prompt}`;
    this.store.updateTicket(id, { activeAgent: role });
    this.log(id, role, 'status', `${agent.name} started`);

    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new Cancelled();
      const attemptAc = new AbortController();
      const onAbort = () => attemptAc.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const act: Activity = { ticketId: id, role, attempt: attemptAc, last: Date.now(), stalled: false };
      this.activity.set(id, act);
      const before = this.store.ticket(id)!;
      const remaining = s.budgetPerTicketUsd > 0 ? Math.max(0.05, s.budgetPerTicketUsd - before.costUsd) : undefined;
      const nudge = attempt
        ? `⏰ The factory's watchdog restarted you: your previous attempt went quiet for too long (likely a hung command or a wait on something that never came). Don't repeat whatever blocked; finish the task${schema ? ' and return the structured result' : ''}.\n\n`
        : '';
      try {
        const r = await this.runner.run({
          agent, prompt: nudge + prompt, cwd, schema, signal: attemptAc.signal,
          budgetUsd: s.mode === 'live' ? remaining : undefined,
          onEvent: (kind, text) => {
            act.last = Date.now();
            this.log(id, role, kind, text);
          },
        });
        const t = this.store.ticket(id)!;
        this.store.updateTicket(id, { costUsd: +(t.costUsd + r.costUsd).toFixed(4), tokens: t.tokens + r.tokens });
        // Finished without the result we asked for → one nudge to produce it.
        if (schema && r.structured === undefined && attempt < maxNudges) {
          this.log(id, 'factory', 'status', `⏰ Watchdog: ${agent.name} finished without a result — asking again.`);
          continue;
        }
        this.log(id, role, 'status', `${agent.name} finished ($${r.costUsd.toFixed(3)})`);
        return r;
      } catch (err) {
        if (signal.aborted) throw new Cancelled();
        if (act.stalled) {
          const minutes = Math.round(this.stallMs() / 60_000) || 1;
          if (attempt < maxNudges) {
            this.log(id, 'factory', 'status', `⏰ Watchdog: ${agent.name} went quiet — nudging (${attempt + 1}/${maxNudges}).`);
            continue;
          }
          throw new Stuck(role, minutes, attempt);
        }
        throw err;
      } finally {
        signal.removeEventListener('abort', onAbort);
        if (this.activity.get(id) === act) this.activity.delete(id);
      }
    }
  }

  // ------------------------------------------------------------------ watchdog + reconcile
  private stallMs() {
    const s = this.store.settings();
    // Simulated agents emit every few seconds, so a short fuse keeps the demo lively.
    return s.mode === 'mock' ? 20_000 * this.speed : Math.max(1, s.watchdog.stallMinutes) * 60_000;
  }

  private watchdogTick() {
    const s = this.store.settings();
    if (s.watchdog.enabled) {
      const limit = this.stallMs();
      for (const act of this.activity.values()) {
        if (!act.stalled && Date.now() - act.last > limit) {
          act.stalled = true;
          act.attempt.abort();
        }
      }
    }
    this.reconcile();
  }

  /** Make the board tell the truth: stages must match what's actually happening. */
  private reconcile() {
    for (const t of this.store.tickets()) {
      if (ACTIVE.includes(t.stage) && !this.running.has(t.id)) {
        this.store.updateTicket(t.id, { stage: 'ready', activeAgent: undefined });
        this.log(t.id, 'factory', 'status', 'Watchdog: no agent was working this ticket — re-queued.');
      }
      if (t.stage === 'awaiting_approval' && !this.store.attention().some((a) => a.ticketId === t.id && (a.status === 'open' || a.status === 'held'))) {
        this.store.postAttention(t.gate === 'plan' ? A.planGate(t) : A.signoff(t));
      }
      if (t.stage === 'failed' && t.error && !this.store.attention().some((a) => a.ticketId === t.id && (a.status === 'open' || a.status === 'held'))) {
        this.store.postAttention(A.failure(t, t.error));
      }
    }
  }

  // ------------------------------------------------------------------ CI gate
  private ciApplies(t: Ticket) {
    const s = this.ps(t);
    if (!s.ciGate.enabled) return false;
    if (s.mode === 'mock') return true; // simulated CI so the flow can be tried end to end
    return s.mergeStrategy === 'pull-request' && github.isEnabled(s);
  }

  private async openOrUpdatePR(id: string) {
    const t = this.store.ticket(id)!;
    const s = this.ps(t);
    if (s.mode === 'mock') {
      if (!t.prNumber) this.store.updateTicket(id, { prNumber: 100 + Math.floor(this.random() * 900) });
      return;
    }
    if (!t.branch || !t.worktree) throw new Error('No branch to open a pull request from.');
    await g.commitAll(t.worktree, `${t.key}: final touches`);
    await g.pushBranch(t.worktree, t.branch);
    if (t.prNumber) {
      this.log(id, 'factory', 'status', `Pushed updates to PR #${t.prNumber}`);
      return;
    }
    const existing = await github.findPR(s, t.branch);
    const closes = t.source === 'github' && t.externalId ? `\n\nCloses #${t.externalId}` : '';
    const pr = existing ?? (await github.createPR(s, t.branch, s.baseBranch, `${t.key}: ${t.title}`,
      `${t.plan?.summary ?? t.description}\n\n${t.review ? `**Review:** ${t.review.summary}` : ''}${closes}\n\n_Built by AI Dev Factory_`));
    this.store.updateTicket(id, { prNumber: pr.number, prUrl: pr.url });
    this.log(id, 'factory', 'status', `Opened pull request #${pr.number} ${pr.url}`);
  }

  private async ciTick() {
    const s = this.store.settings();
    const interval = s.mode === 'mock' ? 4000 * this.speed : Math.max(10, s.ciGate.pollSeconds) * 1000;
    for (const t of this.store.tickets().filter((x) => x.stage === 'ci')) {
      if (Date.now() - (this.ciPolled.get(t.id) ?? 0) < interval) continue;
      this.ciPolled.set(t.id, Date.now());
      try {
        const r = s.mode === 'mock' ? this.mockChecks(t) : await github.prChecks(this.ps(t), t.prNumber!);
        if ('merged' in r && r.merged) {
          this.log(t.id, 'factory', 'status', `PR #${t.prNumber} was merged outside the factory.`);
          await this.markDone(t.id, t.prUrl);
          continue;
        }
        if ('closed' in r && r.closed) {
          const e = this.store.updateTicket(t.id, { stage: 'failed', error: `PR #${t.prNumber} was closed.` })!;
          this.store.postAttention(A.failure(e, e.error!));
          continue;
        }
        const since = t.ci?.sha && r.sha && t.ci.sha !== r.sha ? Date.now() : t.ci?.since ?? Date.now();
        let state = r.state;
        // Checks can take a minute to register on a fresh push — "none" only counts after that.
        if (state === 'none' && Date.now() - since < 60_000) state = 'pending';
        this.store.updateTicket(t.id, { ci: { state, checks: r.checks, sha: r.sha, since, updatedAt: Date.now() } });
        if (state === 'pending') {
          const waited = (Date.now() - since) / 60_000;
          if (waited > s.ciGate.maxWaitMinutes && !this.store.openAttention(A.keys.ciWait(t))) {
            this.store.postAttention(A.ciTooSlow(this.store.ticket(t.id)!, Math.round(waited)));
          }
          continue;
        }
        this.ciSettled(t.id, state, r.checks);
      } catch (err) {
        this.log(t.id, 'factory', 'error', `CI check failed: ${(err as Error).message}`);
      }
    }
  }

  private mockChecks(t: Ticket): { sha: string; state: CheckState; checks: CiCheck[] } {
    const n = (this.mockCiPolls.get(t.id) ?? 0) + 1;
    this.mockCiPolls.set(t.id, n);
    const names = ['build', 'lint', 'unit tests'];
    if (n < 3) return { sha: 'mock', state: 'pending', checks: names.map((name, i) => ({ name, state: i < n ? 'success' : 'pending' })) };
    // First run on a ticket fails a quarter of the time, so you can see red CI loop back.
    const fail = t.iterations === 0 && (this.mockOpts.ciPasses ? !this.mockOpts.ciPasses(t.key) : (t.key.charCodeAt(t.key.length - 1) + (t.prNumber ?? 0)) % 4 === 0);
    const checks: CiCheck[] = names.map((name) => ({ name, state: fail && name === 'unit tests' ? 'failure' : 'success' }));
    return { sha: 'mock', state: fail ? 'failure' : 'success', checks };
  }

  /** CI finished (or was skipped): release sign-off, or send red CI back to the Coder. */
  private ciSettled(id: string, state: CheckState, checks: CiCheck[]) {
    const s = this.store.settings();
    const t = this.store.ticket(id)!;
    this.store.closeAttentionFor(id, 'ciwait');
    if (state === 'failure') {
      const failed = checks.filter((c) => c.state === 'failure');
      const iterations = t.iterations + 1;
      this.store.updateTicket(id, {
        iterations,
        testReport: {
          passed: false,
          summary: `CI failed: ${failed.map((c) => c.name).join(', ') || 'checks'}`,
          failures: failed.map((c) => `${c.name}${c.url ? ` — ${c.url}` : ''}`),
        },
      });
      this.store.closeAttentionFor(id, 'merge');
      this.log(id, 'factory', 'status', `❌ CI failed (${failed.map((c) => c.name).join(', ')}) — back to the Coder, not to you.`);
      this.store.emit('notify', { event: 'ciFailed', ticketId: id, title: `CI failed on ${t.key}`, body: `${failed.map((c) => c.name).join(', ')} — sent back to the Coder.` });
      if (iterations >= s.maxLoops) {
        const e = this.store.updateTicket(id, { stage: 'awaiting_approval', gate: 'merge' })!;
        this.store.postAttention(A.escalation(e, `CI kept failing after ${iterations} loops.`));
        return;
      }
      this.store.updateTicket(id, { stage: 'ready' });
      void this.pipeline(id, 'code');
      return;
    }

    this.log(id, 'factory', 'status', state === 'success' ? '✅ CI is green.' : 'No CI checks — continuing.');
    if (!s.gates.merge) {
      void this.finalize(id);
      return;
    }
    this.score(id);
    const e = this.store.updateTicket(id, { stage: 'awaiting_approval', gate: 'merge' })!;
    // Re-posting supersedes the held item: same cases, now open, with the green CI in its brief.
    this.store.postAttention(A.signoff(e));
    void this.sync(e, 'awaiting_approval', 'Implementation complete, reviewed and CI green — awaiting PM sign-off.');
  }

  // ------------------------------------------------------------------ git / workspace
  private async workspace(t: Ticket): Promise<string> {
    const s = this.ps(t);
    if (s.mode === 'mock') return process.cwd();
    if (!s.repoPath || !(await g.isGitRepo(s.repoPath))) {
      throw new Error(`Live mode needs a git repository — set the repository path for project "${this.store.project(t.projectId).name}" in Settings → Projects.`);
    }
    const root = g.worktreesRoot(s.repoPath, s.worktreesDir);
    const { branch, dir } = await g.ensureWorktree(s.repoPath, root, s.baseBranch, t.key, t.title);
    if (t.worktree !== dir) {
      await g.excludeFactoryDir(dir);
      this.store.updateTicket(t.id, { branch, worktree: dir });
      this.log(t.id, 'factory', 'status', `Workspace ready on branch ${branch}`);
    }
    return dir;
  }

  private async commit(t: Ticket, cwd: string, msg: string) {
    if (this.store.settings().mode === 'mock') return;
    if (await g.commitAll(cwd, msg)) this.log(t.id, 'factory', 'status', `Committed: ${msg}`);
  }

  private async diff(t: Ticket, cwd: string) {
    const s = this.ps(t);
    if (s.mode === 'mock') return mockDiff(t.key, t.title);
    return g.diffAgainstBase(cwd, s.baseBranch);
  }

  private async finalize(id: string) {
    this.hooks.onFinished?.(id); // stop its preview before the worktree goes away
    const t = this.store.ticket(id)!;
    const s = this.ps(t);
    try {
      let prUrl = t.prUrl;
      let ship: ShipInfo = s.mode === 'mock' ? { how: 'simulated', sha: `mock-${t.key.toLowerCase()}`, at: Date.now() } : { how: 'branch', at: Date.now() };
      if (s.mode === 'live' && t.branch && t.worktree) {
        await g.commitAll(t.worktree, `${t.key}: final touches`);
        if (t.prNumber && this.ciApplies(t)) {
          // The CI gate already opened the PR — shipping means merging it.
          const merged = await github.mergePR(s, t.prNumber, s.ciGate.mergeMethod, `${t.key}: ${t.title} (#${t.prNumber})`);
          ship = { how: 'pull-request', sha: merged?.sha, at: Date.now() };
          this.log(id, 'factory', 'status', `Merged PR #${t.prNumber} (${s.ciGate.mergeMethod})`);
        } else if (s.mergeStrategy === 'local-merge') {
          await g.mergeBranch(s.repoPath, t.branch, `Merge ${t.key}: ${t.title}`);
          ship = { how: 'local-merge', sha: await g.git(s.repoPath, 'rev-parse', 'HEAD'), at: Date.now() };
          this.log(id, 'factory', 'status', `Merged ${t.branch} into ${s.baseBranch}`);
        } else if (s.mergeStrategy === 'pull-request') {
          ship = { how: 'pull-request', at: Date.now() };
          await g.pushBranch(t.worktree, t.branch);
          const closes = t.source === 'github' && t.externalId ? `\n\nCloses #${t.externalId}` : '';
          const pr = await github.createPR(s, t.branch, s.baseBranch, `${t.key}: ${t.title}`, `${t.plan?.summary ?? t.description}\n\n${t.review ? `**Review:** ${t.review.summary}` : ''}${closes}\n\n_Built by AI Dev Factory_`);
          prUrl = pr.url;
          this.store.updateTicket(id, { prNumber: pr.number });
          this.log(id, 'factory', 'status', `Opened pull request ${prUrl}`);
        }
        if (s.mergeStrategy !== 'none' && fs.existsSync(t.worktree)) await g.removeWorktree(s.repoPath, t.worktree);
      }
      this.store.updateTicket(id, { ship });
      await this.markDone(id, prUrl);
      if (ship.sha && s.quality.smoke) void this.smoke(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const e = this.store.updateTicket(id, { stage: 'failed', error: `Finalize failed: ${msg}` })!;
      this.store.postAttention(A.failure(e, e.error!));
      this.log(id, 'factory', 'error', `Finalize failed: ${msg}`);
    }
  }

  private async markDone(id: string, prUrl?: string) {
    const t = this.store.ticket(id)!;
    const s = this.ps(t);
    this.hooks.onFinished?.(id);
    this.store.closeAttentionFor(id);
    void this.harvest.stopIfRunning(id);
    const done = this.store.updateTicket(id, { stage: 'done', gate: undefined, activeAgent: undefined, finishedAt: Date.now(), prUrl, worktree: s.mergeStrategy === 'none' ? t.worktree : undefined })!;
    this.log(id, 'factory', 'status', '🎉 Shipped.');
    await this.sync(done, 'done', prUrl ? `Shipped via ${prUrl}` : 'Change approved by PM and shipped.');
  }

  private async sync(t: Ticket, stage: Stage, message: string) {
    if (t.source === 'local') return;
    const c = connectorFor(t.source);
    const s = this.ps(t);
    if (!c || !c.isEnabled(s)) return;
    try {
      await c.onStage(s, t, stage, message);
    } catch (err) {
      this.log(t.id, 'factory', 'error', `${c.label} sync failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ------------------------------------------------------------------ output normalizers
function arr(x: unknown): string[] {
  return Array.isArray(x) ? x.map(String) : [];
}

function normalizePlan(x: unknown, text: string): Plan {
  const o = (x ?? {}) as Record<string, unknown>;
  return { summary: String(o.summary ?? text.slice(0, 400)), steps: arr(o.steps), risks: arr(o.risks), files: arr(o.files) };
}

function normalizeTest(x: unknown, text: string): TestReport {
  const o = (x ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(2) : undefined);
  const cov = (o.coverage ?? undefined) as Record<string, unknown> | undefined;
  const criteria = Array.isArray(o.criteria)
    ? (o.criteria as Array<Record<string, unknown>>)
        .filter((c) => c && c.criterion)
        .map((c) => ({
          criterion: String(c.criterion),
          status: (['proven', 'unproven', 'failed'].includes(String(c.status)) ? c.status : 'unproven') as 'proven' | 'unproven' | 'failed',
          evidence: c.evidence ? String(c.evidence) : undefined,
        }))
    : undefined;
  return {
    passed: o.passed === undefined ? !/fail/i.test(text) : Boolean(o.passed),
    summary: String(o.summary ?? text.slice(0, 300)),
    failures: arr(o.failures),
    testsAdded: num(o.testsAdded),
    criteria,
    coverage: cov
      ? {
          before: num(cov.before),
          after: num(cov.after),
          files: Array.isArray(cov.files) ? (cov.files as Array<Record<string, unknown>>).map((f) => ({ file: String(f.file), pct: num(f.pct) ?? 0 })) : undefined,
        }
      : undefined,
  };
}

function normalizeReview(x: unknown, text: string): Review {
  const o = (x ?? {}) as Record<string, unknown>;
  const comments = Array.isArray(o.comments) ? (o.comments as Review['comments']) : [];
  const w = (o.walkthrough ?? undefined) as Record<string, unknown> | undefined;
  const cases = Array.isArray(w?.cases)
    ? (w!.cases as Array<Record<string, unknown>>)
        .map((c) => ({ title: String(c.title ?? ''), steps: arr(c.steps), expect: String(c.expect ?? ''), screenshot: c.screenshot ? String(c.screenshot) : undefined }))
        .filter((c) => c.title && c.expect)
        .slice(0, 8)
    : [];
  return {
    verdict: o.verdict === 'request_changes' ? 'request_changes' : 'approve',
    summary: String(o.summary ?? text.slice(0, 300)),
    comments,
    walkthrough: cases.length ? { setup: arr(w?.setup), cases } : undefined,
  };
}
