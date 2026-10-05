import type { AttentionItem, CaseVerdict, Ticket, Walkthrough } from './types.js';

/**
 * Builders for everything that lands in the PM's "Needs you" inbox.
 * Each decision carries a brief: what we recommend, what settles it,
 * why it's being asked now, and what happens if it waits.
 */

type NewItem = Omit<AttentionItem, 'id' | 'createdAt' | 'updatedAt' | 'status'> & { status?: AttentionItem['status'] };

export const keys = {
  plan: (t: Ticket) => `plan:${t.id}`,
  signoff: (t: Ticket) => `merge:${t.id}`,
  escalate: (t: Ticket) => `escalate:${t.id}`,
  error: (t: Ticket) => `error:${t.id}`,
  stuck: (t: Ticket) => `stuck:${t.id}`,
  ciWait: (t: Ticket) => `ciwait:${t.id}`,
  smoke: (t: Ticket) => `smoke:${t.id}`,
};

export function planGate(t: Ticket): NewItem {
  const risks = t.plan?.risks ?? [];
  return {
    kind: 'decision',
    ticketId: t.id,
    key: keys.plan(t),
    title: `Approve the plan for ${t.key}?`,
    body: [t.plan?.summary, ...(t.plan?.steps ?? []).map((s, i) => `${i + 1}. ${s}`)].filter(Boolean).join('\n'),
    brief: {
      recommend: risks.length ? `Approve, and keep an eye on: ${risks[0]}` : 'Approve — the plan is small and self-contained.',
      clearsWhen: 'You approve it, or send it back with direction.',
      whyNow: 'Coding on this ticket can’t start until the plan is approved.',
      ifItWaits: 'This ticket stays parked; the rest of the queue keeps moving.',
    },
    options: [
      { id: 'approve', label: 'Approve plan', primary: true },
      { id: 'sendback', label: 'Send back', needsText: true },
    ],
  };
}

/** Fallback cases when the reviewer didn't write a walkthrough (e.g. reviewer disabled). */
function defaultWalkthrough(t: Ticket): Walkthrough {
  return {
    setup: ['Check out the branch and run the app the way you normally do.'],
    cases: [
      {
        title: `Does it do what ${t.key} asked?`,
        steps: ['Read the ticket description once more', 'Exercise the change in the app'],
        expect: t.description ? t.description.split('\n')[0].slice(0, 200) : 'The behavior described in the ticket.',
      },
    ],
  };
}

export function signoff(t: Ticket, held?: string): NewItem {
  const w = t.review?.walkthrough?.cases?.length ? t.review.walkthrough : defaultWalkthrough(t);
  const tests = t.testReport ? (t.testReport.passed ? 'tests pass' : 'tests did NOT pass') : 'no automated tests ran';
  const reviewed = t.review ? (t.review.verdict === 'approve' ? 'the reviewer approved' : 'the reviewer still has concerns') : 'no code review ran';
  const ci = t.ci ? (t.ci.state === 'success' ? ', CI is green' : t.ci.state === 'none' ? ', no CI checks configured' : '') : '';
  return {
    kind: 'review',
    ticketId: t.id,
    key: keys.signoff(t),
    title: `Sign off ${t.key}: ${t.title}`,
    body: t.review?.summary,
    review: { summary: t.review?.summary ?? t.plan?.summary ?? t.title, setup: w.setup, cases: w.cases },
    brief: {
      recommend: signoffAdvice(t, w.cases.length, `${tests}, ${reviewed}${ci}`),
      clearsWhen: 'Every case is approved (ships), or you send feedback (goes back to the Coder).',
      whyNow: 'The work is finished; nothing merges without your sign-off.',
      ifItWaits: 'The branch can drift from main and need a rebase; the agents move on to other tickets.',
    },
    options: [
      { id: 'ship', label: 'Approve & ship', primary: true },
      { id: 'sendback', label: 'Send back', needsText: true },
    ],
    status: held ? 'held' : 'open',
    heldReason: held,
  };
}

/** The sign-off recommendation, sharpened by the safety score and any criteria without proof. */
function signoffAdvice(t: Ticket, cases: number, facts: string) {
  const walk = `Walk the ${cases} case${cases === 1 ? '' : 's'}`;
  const missing = (t.testReport?.criteria ?? []).filter((c) => c.status !== 'proven');
  const c = t.confidence;
  if (missing.length) return `${walk}, and check ${missing.length === 1 ? 'this criterion by hand — it has' : `these ${missing.length} criteria by hand — they have`} no test proving ${missing.length === 1 ? 'it' : 'them'}: ${missing.map((m) => `“${m.criterion}”`).join(', ')}.`;
  if (c?.level === 'low') return `Look closely before shipping (safety ${c.score}/100): ${c.reasons.filter((r) => !r.ok).map((r) => r.text.toLowerCase()).join('; ')}.`;
  if (c?.level === 'medium') return `${walk} and ship, but note: ${c.reasons.filter((r) => !r.ok).map((r) => r.text.toLowerCase()).join('; ')} (safety ${c.score}/100).`;
  return `${walk} and ship — ${facts}.`;
}

/** The base branch's smoke test failed right after this ticket shipped. */
export function smokeFailed(t: Ticket, output: string): NewItem {
  const tail = output.trim().split('\n').slice(-12).join('\n');
  return {
    kind: 'decision',
    ticketId: t.id,
    key: keys.smoke(t),
    title: `Smoke test failed after shipping ${t.key}`,
    body: tail ? `\`\`\`\n${tail}\n\`\`\`` : undefined,
    brief: {
      recommend: 'Revert it now, then let the agents redo it with the failure as context.',
      clearsWhen: 'You revert, ask for a fix-forward ticket, or keep it as is.',
      whyNow: 'The smoke test passed before this change landed and fails right after it.',
      ifItWaits: 'Everyone building on the base branch starts from something broken.',
    },
    options: [
      { id: 'revert', label: 'Revert & redo', primary: true },
      { id: 'fixforward', label: 'Keep it, open a fix ticket' },
      { id: 'keep', label: 'Ignore — it’s a flaky test' },
    ],
  };
}

export function escalation(t: Ticket, reason: string): NewItem {
  const budget = /budget/i.test(reason);
  return {
    kind: 'decision',
    ticketId: t.id,
    key: keys.escalate(t),
    title: `${t.key} needs a call: ${budget ? 'budget reached' : 'rework limit reached'}`,
    body: reason,
    brief: {
      recommend: budget
        ? 'Read the latest review, then either raise the budget and send it back with focused direction, or ship what’s there.'
        : 'Read the open review comments. If they’re nits, ship; otherwise send back one specific instruction.',
      clearsWhen: 'You ship it as-is, send it back with direction, or park it in the backlog.',
      whyNow: budget ? 'The agents stopped so they don’t keep spending.' : 'The agents went around the loop the maximum number of times without converging.',
      ifItWaits: 'Nothing else happens on this ticket; its branch stays as it is.',
    },
    options: [
      { id: 'ship', label: 'Ship as-is' },
      { id: 'sendback', label: 'Send back with direction', primary: true, needsText: true },
      { id: 'backlog', label: 'Park in backlog' },
    ],
  };
}

export function failure(t: Ticket, message: string): NewItem {
  return {
    kind: 'error',
    ticketId: t.id,
    key: keys.error(t),
    title: `${t.key} failed`,
    body: message,
    brief: {
      recommend: /repository|repo path|git/i.test(message)
        ? 'Fix the repository setting in Settings, then retry.'
        : 'Retry once — most failures are transient. If it fails again, read the agent log.',
      clearsWhen: 'You retry it or park it.',
      whyNow: 'The pipeline stopped on an error it couldn’t recover from by itself.',
      ifItWaits: 'The ticket sits in Failed; nothing else is affected.',
    },
    options: [
      { id: 'retry', label: 'Retry', primary: true },
      { id: 'backlog', label: 'Park in backlog' },
    ],
  };
}

export function stuck(t: Ticket, agentName: string, minutes: number, nudges: number): NewItem {
  return {
    kind: 'decision',
    ticketId: t.id,
    key: keys.stuck(t),
    title: `${agentName} is stuck on ${t.key}`,
    body: `No activity for ${minutes} min, even after ${nudges} nudge${nudges === 1 ? '' : 's'}.`,
    brief: {
      recommend: 'Retry — a fresh run usually gets past a hung command. Add a note if you know what it was waiting on.',
      clearsWhen: 'You retry it or park it.',
      whyNow: 'The watchdog already nudged it automatically and it still didn’t move.',
      ifItWaits: 'The ticket stays in Failed and frees its slot for other work.',
    },
    options: [
      { id: 'retry', label: 'Retry', primary: true },
      { id: 'backlog', label: 'Park in backlog' },
    ],
  };
}

export function ciTooSlow(t: Ticket, minutes: number): NewItem {
  return {
    kind: 'decision',
    ticketId: t.id,
    key: keys.ciWait(t),
    title: `CI on ${t.key} is still running after ${minutes} min`,
    body: t.prUrl ? `Pull request: ${t.prUrl}` : undefined,
    brief: {
      recommend: 'Keep waiting unless you know the runner is broken.',
      clearsWhen: 'Checks finish, or you choose to stop waiting.',
      whyNow: 'The checks have run longer than the limit in Settings.',
      ifItWaits: 'The factory keeps polling; sign-off stays held until CI is green.',
    },
    options: [
      { id: 'wait', label: 'Keep waiting', primary: true },
      { id: 'skip', label: 'Skip CI and sign off' },
    ],
  };
}

/** Turn walkthrough verdicts into one message for the Coder. */
export function consolidate(item: AttentionItem, verdicts: CaseVerdict[] = [], notes?: string) {
  const cases = item.review?.cases ?? [];
  const lines: string[] = [];
  verdicts.forEach((v, i) => {
    if (v.verdict === 'feedback' && v.feedback?.trim()) lines.push(`- Case ${i + 1} (${cases[i]?.title ?? 'case'}): ${v.feedback.trim()}`);
  });
  if (notes?.trim()) lines.push(`- General: ${notes.trim()}`);
  const allApproved = cases.length > 0 && cases.every((_, i) => verdicts[i]?.verdict === 'approved') && !notes?.trim();
  return { allApproved, feedback: lines.length ? `PM review feedback:\n${lines.join('\n')}` : '' };
}
