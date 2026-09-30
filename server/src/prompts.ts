import type { Ticket } from './types.js';

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'steps', 'risks', 'files'],
};

export const TEST_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    summary: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
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

Produce an implementation plan for this ticket. Return it in the structured output format.`;
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
Return passed, a one-line summary, and a list of failures in the structured output format.`;
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
