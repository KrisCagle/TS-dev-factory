import fs from 'node:fs';
import { ClaudeRunner, extractJson } from './agents/runner.js';
import type { Store } from './store.js';
import type { AgentConfig, Priority } from './types.js';

export interface ScopeInput {
  text: string;
  projectId?: string;
  answers?: Array<{ q: string; a: string }>;
}

export interface ScopeDraft {
  title: string;
  description: string;
  priority: Priority;
  labels: string[];
  questions: string[];
}

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Imperative, under 70 characters' },
    description: { type: 'string', description: 'Markdown: Context, Acceptance criteria (checklist), Out of scope, Notes' },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    labels: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' }, description: 'At most 2, only when the answer would change the ticket' },
  },
  required: ['title', 'description', 'priority', 'labels', 'questions'],
};

const PROMPT = `You are the Scoper in an AI software factory. You turn a PM's rough input — an idea, a bug report,
a pasted Slack thread — into one clear ticket that coding agents can implement without guessing.

Write:
- title: imperative, specific, under 70 characters ("Add CSV export to the reports table").
- description in Markdown with these sections:
  ## Context — why this matters, in 1–3 sentences, from the input.
  ## Acceptance criteria — a "- [ ]" checklist of observable behaviors. Include the main edge case.
  ## Out of scope — what not to touch, if it's worth saying.
  ## Notes — file paths or components you found in the repo, if any.
- priority: urgent only for outages/data loss/security; high for broken user flows; low for polish.
- labels: 1–3 short lowercase words (bug, frontend, backend, api, auth, ux, chore…).
- questions: ask at most 2, and only when the answer would change what gets built. Prefer to decide
  sensibly and state the assumption in Notes. If answers are provided, ask nothing further.

You may read the repository (Read/Glob/Grep) to ground the ticket in real file names. Don't modify anything.`;

/** Rough idea → a ticket agents can run with. */
export class Scoper {
  private claude = new ClaudeRunner();

  constructor(private store: Store) {}

  async draft(input: ScopeInput): Promise<ScopeDraft> {
    const text = input.text.trim();
    if (!text) throw Object.assign(new Error('Paste or type something to turn into a ticket.'), { status: 400 });
    const s = this.store.settings();
    if (s.mode === 'mock') return heuristic(text, input.answers);

    const project = this.store.project(input.projectId);
    const cwd = project.repoPath && fs.existsSync(project.repoPath) ? project.repoPath : process.cwd();
    const agent: AgentConfig = {
      role: 'planner', name: 'Scoper', enabled: true, model: s.scoper.model || 'sonnet', color: '#a855f7',
      systemPrompt: PROMPT, allowedTools: ['Read', 'Glob', 'Grep'], maxTurns: 15,
    };
    const answers = input.answers?.length ? `\n\nThe PM answered your questions:\n${input.answers.map((x) => `- ${x.q} → ${x.a}`).join('\n')}\nDo not ask more questions.` : '';
    const r = await this.claude.run({
      agent,
      prompt: `Project: ${project.name}\n\nPM input:\n"""\n${text}\n"""${answers}\n\nReturn the ticket in the structured output format.`,
      cwd,
      schema: SCHEMA,
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    const o = (r.structured ?? extractJson(r.text) ?? {}) as Partial<ScopeDraft>;
    return {
      title: String(o.title ?? text.slice(0, 70)),
      description: String(o.description ?? text),
      priority: (['low', 'medium', 'high', 'urgent'] as Priority[]).includes(o.priority as Priority) ? (o.priority as Priority) : 'medium',
      labels: Array.isArray(o.labels) ? o.labels.map(String).slice(0, 4) : [],
      questions: input.answers?.length ? [] : Array.isArray(o.questions) ? o.questions.map(String).slice(0, 2) : [],
    };
  }
}

/** Simulated-mode stand-in: shapes the input into the same structure without calling Claude. */
function heuristic(text: string, answers?: ScopeInput['answers']): ScopeDraft {
  const lower = text.toLowerCase();
  const first = text.split(/(?<=[.!?])\s|\n/)[0].replace(/^(please|can we|could we|we need to|i want to|we should)\s+/i, '').trim();
  let title = first.charAt(0).toUpperCase() + first.slice(1);
  if (title.length > 70) title = `${title.slice(0, 67).replace(/\s+\S*$/, '')}…`;
  title = title.replace(/[.?!]+$/, '');
  const priority: Priority = /outage|down|data loss|security|asap|urgent|crash/.test(lower) ? 'urgent'
    : /bug|broken|error|fails?|can'?t|cannot|wrong/.test(lower) ? 'high'
    : /polish|nice to have|someday|minor|typo/.test(lower) ? 'low' : 'medium';
  const labelMap: Array<[RegExp, string]> = [
    [/bug|broken|error|fail|crash|wrong/, 'bug'], [/button|page|screen|ui|css|layout|modal|dark mode/, 'frontend'],
    [/api|endpoint|server|database|query|webhook/, 'backend'], [/login|auth|password|token|sso/, 'auth'], [/slow|performance|speed|timeout/, 'perf'],
  ];
  const labels = labelMap.filter(([re]) => re.test(lower)).map(([, l]) => l).slice(0, 3);
  const answered = answers?.length ? `\n\n## Decisions from the PM\n${answers.map((a) => `- **${a.q}** ${a.a}`).join('\n')}` : '';
  const description = `## Context
${text.trim()}

## Acceptance criteria
- [ ] The behavior described above works end to end in the running app
- [ ] Empty, missing or invalid input shows a clear message instead of an error
- [ ] Existing behavior elsewhere is unchanged, and tests cover the new behavior

## Out of scope
- Redesigning unrelated screens or refactoring code the change doesn't need${answered}

## Notes
_Drafted by the Scoper in simulated mode. In Live mode it reads your repo and names the real files involved._`;
  const questions = answers?.length || text.length > 120 ? [] : [
    'Who is this for, and where in the app do they run into it?',
    'How will you know it’s done — what should a user see?',
  ];
  return { title, description, priority, labels, questions };
}
