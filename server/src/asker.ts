import fs from 'node:fs';
import { ClaudeRunner } from './agents/runner.js';
import { changedFiles, diffSize, unproven } from './quality.js';
import type { Store } from './store.js';
import type { AgentConfig, Ticket } from './types.js';

const MAX_Q = 2_000;

/**
 * "Ask this ticket": answers questions about a ticket from what the factory knows —
 * the plan, agent log, tests, review and diff. In live mode a read-only Claude session
 * looks at the ticket's branch copy too.
 */
export class Asker {
  private claude = new ClaudeRunner();
  constructor(private store: Store) {}

  async ask(id: string, question: string) {
    const t = this.store.ticket(id);
    if (!t) throw Object.assign(new Error('Ticket not found'), { status: 404 });
    const q = question.trim().slice(0, MAX_Q);
    if (!q) throw Object.assign(new Error('Ask a question first.'), { status: 400 });
    const a = this.store.settings().mode === 'live' ? await this.live(t, q) : answerFromRecord(t, q, this.store.logs(t.id, 400).map((l) => `${l.agent}: ${l.text}`));
    const chat = [...(t.chat ?? []), { q, a, at: Date.now() }].slice(-30);
    this.store.updateTicket(id, { chat });
    return { q, a };
  }

  private async live(t: Ticket, q: string) {
    const project = this.store.project(t.projectId);
    const cwd = t.worktree && fs.existsSync(t.worktree) ? t.worktree : project.repoPath && fs.existsSync(project.repoPath) ? project.repoPath : process.cwd();
    const agent: AgentConfig = {
      role: 'reviewer', name: 'Ticket guide', enabled: true, model: 'sonnet', color: '#64748b', maxTurns: 12,
      allowedTools: ['Read', 'Glob', 'Grep'],
      systemPrompt: 'You answer a project manager’s questions about one ticket in an AI software factory. Be brief and concrete (2–6 sentences or a short list). Cite files and test names. Never change anything.',
    };
    const r = await this.claude.run({
      agent,
      prompt: `${context(t, this.store.logs(t.id, 200).map((l) => `${l.agent}: ${l.text}`))}\n\n## The PM asks\n${q}`,
      cwd,
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    return r.text.trim() || 'I couldn’t find an answer to that in this ticket.';
  }
}

function context(t: Ticket, log: string[]) {
  const diff = t.diff ?? '';
  return [
    `# ${t.key}: ${t.title} (stage: ${t.stage})`,
    t.description,
    t.plan ? `## Plan\n${t.plan.summary}\n${t.plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
    t.testReport ? `## Tests\n${t.testReport.passed ? 'PASSED' : 'FAILED'}: ${t.testReport.summary}` : '',
    t.review ? `## Review (${t.review.verdict})\n${t.review.summary}` : '',
    t.notes.length ? `## PM notes\n${t.notes.map((n) => `- ${n.text}`).join('\n')}` : '',
    diff ? `## Diff (truncated)\n\`\`\`diff\n${diff.slice(0, 20_000)}\n\`\`\`` : '',
    `## Agent log (latest)\n${log.slice(-60).join('\n')}`,
  ].filter(Boolean).join('\n\n');
}

/** Simulated mode: answer the common questions straight from the ticket's record. */
export function answerFromRecord(t: Ticket, q: string, log: string[] = []): string {
  const s = q.toLowerCase();
  const files = changedFiles(t.diff);
  const size = diffSize(t.diff);
  const out: string[] = [];

  if (/\bwhy\b.*\b(change|touch|edit)|which files|what files|\bfiles?\b/.test(s)) {
    if (files.length) {
      out.push(`It changes ${files.length} file${files.length === 1 ? '' : 's'} (${size.added} lines added, ${size.removed} removed): ${files.join(', ')}.`);
      if (t.plan) out.push(`That follows the plan: ${t.plan.summary}`);
    } else if (t.plan?.files.length) out.push(`Nothing is changed yet. The plan expects to touch ${t.plan.files.join(', ')}.`);
    else out.push('No files have changed yet.');
  }
  if (/left|remaining|status|where|stuck|waiting|next|done yet|eta/.test(s)) {
    const next: Record<string, string> = {
      backlog: 'It’s in the backlog — move it to Ready when you want the agents to start.',
      ready: t.waitingOn ? `It’s queued, waiting on ${t.waitingOn.keys.join(', ')} (${t.waitingOn.reason === 'dependency' ? 'a dependency that hasn’t shipped' : `they’re changing ${t.waitingOn.files?.join(', ')}`}).` : 'It’s next in the queue.',
      planning: 'The Planner is writing the plan.',
      coding: `The Coder is implementing it${t.iterations ? ` (rework loop ${t.iterations})` : ''}.`,
      testing: 'The Tester is running the tests.',
      reviewing: 'The Reviewer is reading the diff.',
      ci: 'The pull request is open and CI is running.',
      awaiting_approval: t.gate === 'plan' ? 'It’s waiting for you to approve the plan.' : 'It’s waiting for your sign-off — open it from Needs you.',
      manual: 'You have it in your editor. Hand it back when you’re done.',
      done: t.ship?.reverted ? 'It shipped and was then reverted.' : 'It has shipped.',
      failed: `It failed: ${t.error ?? 'see the agent log'}.`,
    };
    out.push(next[t.stage] ?? `Stage: ${t.stage}.`);
    const missing = unproven(t);
    if (missing.length && t.stage !== 'done') out.push(`Still without proof: ${missing.map((c) => c.criterion).join('; ')}.`);
  }
  if (/test|pass|fail|cover/.test(s)) {
    if (t.testReport) {
      out.push(`Tests ${t.testReport.passed ? 'pass' : 'fail'}: ${t.testReport.summary}`);
      if (t.testReport.failures.length) out.push(`Failures: ${t.testReport.failures.join('; ')}`);
      const c = t.testReport.coverage;
      if (c?.before !== undefined && c.after !== undefined) out.push(`Coverage went from ${c.before}% to ${c.after}%.`);
    } else out.push('No tests have run yet.');
  }
  if (/cost|spend|spent|\$|money|budget|token/.test(s)) {
    out.push(`It has cost $${t.costUsd.toFixed(2)} so far (${t.tokens.toLocaleString()} tokens).`);
    if (t.plan?.estimate) out.push(`The forecast was about $${(t.plan.estimate.adjustedCostUsd ?? t.plan.estimate.costUsd).toFixed(2)}.`);
  }
  if (/review|comment|concern|risk/.test(s)) {
    if (t.review) out.push(`Reviewer: ${t.review.verdict === 'approve' ? 'approved' : 'asked for changes'} — ${t.review.summary}${t.review.comments.length ? ` Comments: ${t.review.comments.map((c) => `[${c.severity}] ${c.comment}`).join(' ')}` : ''}`);
    if (t.plan?.risks.length) out.push(`Risks the Planner flagged: ${t.plan.risks.join('; ')}.`);
  }
  if (/loop|rework|sent back|again/.test(s)) {
    const l = t.loops ?? {};
    const parts = Object.entries(l).filter(([, n]) => n).map(([k, n]) => `${n}× ${k === 'pm' ? 'by you' : k}`);
    out.push(parts.length ? `It went back to the Coder ${t.iterations} time${t.iterations === 1 ? '' : 's'} (${parts.join(', ')}).` : 'It hasn’t needed any rework.');
  }
  if (!out.length) {
    const recent = log.slice(-3).join(' · ');
    out.push(`${t.key} is ${t.stage.replace('_', ' ')}.${t.plan ? ` Plan: ${t.plan.summary}` : ''}${recent ? ` Latest: ${recent}` : ''}`);
    out.push('Try asking which files changed, what’s left, whether tests pass, what it cost, or why it was sent back.');
  }
  return out.join('\n');
}
