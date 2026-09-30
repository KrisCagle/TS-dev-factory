import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ClaudeRunner, type AgentRunner } from './agents/runner.js';
import { MockRunner, mockDiff } from './agents/mock.js';
import { connectorFor, github } from './connectors/index.js';
import * as g from './git.js';
import { PLAN_SCHEMA, REVIEW_SCHEMA, TEST_SCHEMA, coderPrompt, plannerPrompt, reviewerPrompt, testerPrompt } from './prompts.js';
import type { Store } from './store.js';
import { PRIORITY_RANK, type AgentRole, type Plan, type Review, type Stage, type TestReport, type Ticket } from './types.js';

type Phase = 'plan' | 'code';
const ACTIVE: Stage[] = ['planning', 'coding', 'testing', 'reviewing'];

class Cancelled extends Error {}
class Escalate extends Error {}

export class Orchestrator {
  private running = new Map<string, AbortController>();
  private claude = new ClaudeRunner();
  private mock = new MockRunner();
  private timer: NodeJS.Timeout | null = null;
  paused = false;
  private shuttingDown = false;

  constructor(private store: Store) {
    // Anything mid-flight when the server stopped goes back in the queue.
    for (const t of store.tickets()) {
      if (ACTIVE.includes(t.stage)) {
        store.updateTicket(t.id, { stage: 'ready', activeAgent: undefined });
        this.log(t.id, 'factory', 'status', 'Server restarted — ticket re-queued.');
      }
    }
  }

  start() {
    this.timer = setInterval(() => this.tick(), 1500);
  }

  stop() {
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    for (const ac of this.running.values()) ac.abort();
  }

  status() {
    return { running: [...this.running.keys()], paused: this.paused };
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.store.emit('factory', this.status());
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
    if (!t || t.stage !== 'awaiting_approval') throw new Error('Ticket is not waiting for approval');
    if (note) this.addNote(id, note);
    this.log(id, 'pm', 'pm', `Approved ${t.gate === 'plan' ? 'the plan' : 'the change'}${note ? `: ${note}` : ''}`);
    if (t.gate === 'plan') void this.pipeline(id, 'code');
    else void this.finalize(id);
  }

  reject(id: string, feedback: string) {
    const t = this.store.ticket(id);
    if (!t || t.stage !== 'awaiting_approval') throw new Error('Ticket is not waiting for approval');
    this.addNote(id, feedback);
    this.store.updateTicket(id, { iterations: 0 });
    this.log(id, 'pm', 'pm', `Sent back: ${feedback}`);
    void this.pipeline(id, t.gate === 'plan' ? 'plan' : 'code');
  }

  cancel(id: string) {
    const ac = this.running.get(id);
    if (ac) ac.abort();
    else this.store.updateTicket(id, { stage: 'backlog', activeAgent: undefined, gate: undefined });
  }

  retry(id: string) {
    this.store.updateTicket(id, { stage: 'ready', error: undefined, gate: undefined });
  }

  addNote(id: string, text: string) {
    const t = this.store.ticket(id);
    if (!t) return;
    this.store.updateTicket(id, { notes: [...t.notes, { id: randomUUID(), text, ts: Date.now() }] });
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
          set({ stage: 'awaiting_approval', gate: 'plan', activeAgent: undefined });
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
          const report = normalizeTest(r.structured, r.text);
          t = set({ testReport: report });
          await this.commit(t, cwd, `${t.key}: tests`);
          this.log(id, 'tester', 'result', `${report.passed ? '✅ Tests passed' : '❌ Tests failed'} — ${report.summary}`);
          if (!report.passed) {
            this.loopBack(id, 'Tests failed');
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
        }
        break;
      }

      t = set({ diff: await this.diff(this.store.ticket(id)!, cwd) });
      if (s.gates.merge) {
        set({ stage: 'awaiting_approval', gate: 'merge', activeAgent: undefined });
        this.log(id, 'factory', 'status', 'Ready for PM sign-off.');
        await this.sync(t, 'awaiting_approval', 'Implementation complete and reviewed — awaiting PM sign-off.');
      } else {
        this.running.delete(id);
        await this.finalize(id);
      }
    } catch (err) {
      if (this.shuttingDown) {
        // leave the stage alone — the constructor re-queues it on next start
      } else if (err instanceof Cancelled || ac.signal.aborted) {
        set({ stage: 'backlog', activeAgent: undefined });
        this.log(id, 'pm', 'pm', 'Cancelled by PM — moved back to backlog.');
      } else if (err instanceof Escalate) {
        set({ stage: 'awaiting_approval', gate: 'merge', activeAgent: undefined });
        this.log(id, 'factory', 'status', `Escalated to PM: ${err.message}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        set({ stage: 'failed', activeAgent: undefined, error: msg });
        this.log(id, 'factory', 'error', msg);
      }
    } finally {
      this.running.delete(id);
      this.store.emit('factory', this.status());
    }
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

  private async runAgent(id: string, role: AgentRole, prompt: string, cwd: string, signal: AbortSignal, schema?: Record<string, unknown>) {
    if (signal.aborted) throw new Cancelled();
    const agent = this.store.agent(role);
    const s = this.store.settings();
    const before = this.store.ticket(id)!;
    this.store.updateTicket(id, { activeAgent: role });
    this.log(id, role, 'status', `${agent.name} started`);
    const remaining = s.budgetPerTicketUsd > 0 ? Math.max(0.05, s.budgetPerTicketUsd - before.costUsd) : undefined;
    try {
      const r = await this.runner.run({
        agent, prompt, cwd, schema, signal, budgetUsd: s.mode === 'live' ? remaining : undefined,
        onEvent: (kind, text) => this.log(id, role, kind, text),
      });
      const t = this.store.ticket(id)!;
      this.store.updateTicket(id, { costUsd: +(t.costUsd + r.costUsd).toFixed(4), tokens: t.tokens + r.tokens });
      this.log(id, role, 'status', `${agent.name} finished ($${r.costUsd.toFixed(3)})`);
      return r;
    } catch (err) {
      if (signal.aborted) throw new Cancelled();
      throw err;
    }
  }

  // ------------------------------------------------------------------ git / workspace
  private async workspace(t: Ticket): Promise<string> {
    const s = this.store.settings();
    if (s.mode === 'mock') return process.cwd();
    if (!s.repoPath || !(await g.isGitRepo(s.repoPath))) {
      throw new Error('Live mode needs a git repository — set "Repository path" in Settings.');
    }
    const root = g.worktreesRoot(s.repoPath, s.worktreesDir);
    const { branch, dir } = await g.ensureWorktree(s.repoPath, root, s.baseBranch, t.key, t.title);
    if (t.worktree !== dir) {
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
    const s = this.store.settings();
    if (s.mode === 'mock') return mockDiff(t.key, t.title);
    return g.diffAgainstBase(cwd, s.baseBranch);
  }

  private async finalize(id: string) {
    const s = this.store.settings();
    const t = this.store.ticket(id)!;
    try {
      let prUrl: string | undefined;
      if (s.mode === 'live' && t.branch && t.worktree) {
        await g.commitAll(t.worktree, `${t.key}: final touches`);
        if (s.mergeStrategy === 'local-merge') {
          await g.mergeBranch(s.repoPath, t.branch, `Merge ${t.key}: ${t.title}`);
          this.log(id, 'factory', 'status', `Merged ${t.branch} into ${s.baseBranch}`);
        } else if (s.mergeStrategy === 'pull-request') {
          await g.pushBranch(t.worktree, t.branch);
          const closes = t.source === 'github' && t.externalId ? `\n\nCloses #${t.externalId}` : '';
          prUrl = await github.createPR(s, t.branch, s.baseBranch, `${t.key}: ${t.title}`, `${t.plan?.summary ?? t.description}\n\n${t.review ? `**Review:** ${t.review.summary}` : ''}${closes}\n\n_Built by AI Dev Factory_`);
          this.log(id, 'factory', 'status', `Opened pull request ${prUrl}`);
        }
        if (s.mergeStrategy !== 'none' && fs.existsSync(t.worktree)) await g.removeWorktree(s.repoPath, t.worktree);
      }
      const done = this.store.updateTicket(id, { stage: 'done', gate: undefined, activeAgent: undefined, finishedAt: Date.now(), prUrl, worktree: s.mergeStrategy === 'none' ? t.worktree : undefined })!;
      this.log(id, 'factory', 'status', '🎉 Shipped.');
      await this.sync(done, 'done', prUrl ? `Pull request opened: ${prUrl}` : 'Change approved by PM and shipped.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.updateTicket(id, { stage: 'failed', error: `Finalize failed: ${msg}` });
      this.log(id, 'factory', 'error', `Finalize failed: ${msg}`);
    }
  }

  private async sync(t: Ticket, stage: Stage, message: string) {
    if (t.source === 'local') return;
    const c = connectorFor(t.source);
    const s = this.store.settings();
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
  return { passed: o.passed === undefined ? !/fail/i.test(text) : Boolean(o.passed), summary: String(o.summary ?? text.slice(0, 300)), failures: arr(o.failures) };
}

function normalizeReview(x: unknown, text: string): Review {
  const o = (x ?? {}) as Record<string, unknown>;
  const comments = Array.isArray(o.comments) ? (o.comments as Review['comments']) : [];
  return { verdict: o.verdict === 'request_changes' ? 'request_changes' : 'approve', summary: String(o.summary ?? text.slice(0, 300)), comments };
}
