import { parseCriteria } from './quality.js';
import type { Ticket } from './types.js';

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths you expect to change' },
    estimate: {
      type: 'object',
      description: 'Forecast for the whole ticket (coding, testing, review, rework)',
      properties: {
        size: { type: 'string', enum: ['S', 'M', 'L', 'XL'] },
        costUsd: { type: 'number', description: 'Expected total agent spend in USD' },
        minutes: { type: 'number', description: 'Expected wall-clock minutes until it is ready for sign-off' },
      },
      required: ['size', 'costUsd', 'minutes'],
    },
  },
  required: ['summary', 'steps', 'risks', 'files'],
};

export const TEST_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    summary: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'number', description: 'How many new tests you added for this change' },
    criteria: {
      type: 'array',
      description: 'One entry per acceptance criterion in the ticket',
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string' },
          status: { type: 'string', enum: ['proven', 'unproven', 'failed'] },
          evidence: { type: 'string', description: 'Test name, screenshot file or command that proves it' },
        },
        required: ['criterion', 'status'],
      },
    },
    coverage: {
      type: 'object',
      description: 'Line coverage in percent, only if the project can measure it',
      properties: {
        before: { type: 'number' },
        after: { type: 'number' },
        files: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, pct: { type: 'number' } }, required: ['file', 'pct'] } },
      },
    },
  },
  required: ['passed', 'summary', 'failures'],
};

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request_changes'] },
    summary: { type: 'string' },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          comment: { type: 'string' },
        },
        required: ['severity', 'comment'],
      },
    },
    walkthrough: {
      type: 'object',
      description: 'Only when approving: how the PM verifies the change by hand.',
      properties: {
        setup: { type: 'array', items: { type: 'string' }, description: 'A URL or a few commands to reach the change.' },
        cases: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              steps: { type: 'array', items: { type: 'string' } },
              expect: { type: 'string', description: 'The one thing the PM should see.' },
              screenshot: { type: 'string', description: 'Optional: file name of a screenshot in .factory/screenshots that shows this case.' },
            },
            required: ['title', 'steps', 'expect'],
          },
        },
      },
      required: ['setup', 'cases'],
    },
  },
  required: ['verdict', 'summary', 'comments'],
};

function header(t: Ticket) {
  const notes = t.notes.length ? `\n\n## PM notes (highest priority)\n${t.notes.map((n) => `- ${n.text}`).join('\n')}` : '';
  return `# Ticket ${t.key}: ${t.title}
Priority: ${t.priority}${t.labels.length ? ` · Labels: ${t.labels.join(', ')}` : ''}

## Description
${t.description || '(no description)'}${notes}`;
}

function planBlock(t: Ticket) {
  if (!t.plan) return '';
  return `\n\n## Approved plan
${t.plan.summary}
${t.plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}${t.plan.files.length ? `\nFiles: ${t.plan.files.join(', ')}` : ''}`;
}

export function plannerPrompt(t: Ticket) {
  return `${header(t)}

Produce an implementation plan for this ticket. List the files you expect to change (repo-relative), and forecast the size, total agent cost in USD and minutes until it's ready for sign-off.
Return it in the structured output format.`;
}

export function coderPrompt(t: Ticket) {
  let feedback = '';
  if (t.testReport && !t.testReport.passed) {
    feedback += `\n\n## Test failures to fix\n${t.testReport.summary}\n${t.testReport.failures.map((f) => `- ${f}`).join('\n')}`;
  }
  if (t.review?.verdict === 'request_changes') {
    feedback += `\n\n## Review comments to address\n${t.review.summary}\n${t.review.comments
      .map((c) => `- [${c.severity}]${c.file ? ` ${c.file}${c.line ? `:${c.line}` : ''}` : ''} ${c.comment}`)
      .join('\n')}`;
  }
  return `${header(t)}${planBlock(t)}${feedback}

Implement the ticket now${feedback ? ', addressing all feedback above' : ''}. Leave your changes in the working tree; the factory will commit them.`;
}

export function testerPrompt(t: Ticket) {
  return `${header(t)}${planBlock(t)}

The engineer has implemented this ticket on the current branch. Verify it: run the relevant tests (and add tests where the project has a suite).
${criteriaBlock(t)}
If the project can measure coverage (e.g. \`vitest --coverage\`, \`jest --coverage\`, \`pytest --cov\`), report line coverage before (on the base branch, \`git stash\` or a clean checkout) and after this change, plus the coverage of the files it touched. Skip coverage if there's no tool for it — don't install one.
Return passed, a one-line summary, failures, testsAdded, criteria and coverage in the structured output format.`;
}

function criteriaBlock(t: Ticket) {
  const cs = parseCriteria(t.description);
  if (!cs.length) return 'For each thing the ticket asks for, say how you proved it works (criteria list).';
  return `## Prove every acceptance criterion
For each one, name the passing test or screenshot that proves it. Mark it "unproven" if nothing does yet, or "failed" if it doesn't work.
${cs.map((c, i) => `${i + 1}. ${c}`).join('\n')}`;
}

export function reviewerPrompt(t: Ticket, diff: string) {
  const clipped = diff.length > 60_000 ? `${diff.slice(0, 60_000)}\n… (diff truncated — use git diff to see the rest)` : diff;
  return `${header(t)}${planBlock(t)}
${t.testReport ? `\n## Test report\n${t.testReport.passed ? 'PASSED' : 'FAILED'}: ${t.testReport.summary}` : ''}

## Diff under review
\`\`\`diff
${clipped || '(empty diff)'}
\`\`\`

Review this change. Return verdict, summary and comments in the structured output format.
If you approve, include the walkthrough (setup + 2–6 test cases) the PM will use to sign off.`;
}
