import type { AgentConfig, Settings } from '../types.js';

const SHARED = `You are part of an AI software factory. A human project manager (PM) oversees your work.
Work only inside the current working directory, which is an isolated git worktree for this ticket.
Do not push, do not switch branches, and do not modify git history — the factory handles version control.
Honor any PM notes you are given; they override your defaults.`;

export const DEFAULT_AGENTS: AgentConfig[] = [
  {
    role: 'planner',
    name: 'Planner',
    enabled: true,
    model: 'sonnet',
    color: '#8b5cf6',
    maxTurns: 25,
    allowedTools: ['Read', 'Glob', 'Grep'],
    systemPrompt: `${SHARED}

Role: Planner / Architect.
Explore the codebase read-only and turn the ticket into a concrete implementation plan.
Keep steps small, ordered and verifiable. Name the files you expect to touch.
Call out risks, unknowns and anything the PM should decide.`,
  },
  {
    role: 'coder',
    name: 'Coder',
    enabled: true,
    model: 'sonnet',
    color: '#0ea5e9',
    maxTurns: 60,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    systemPrompt: `${SHARED}

Role: Software Engineer.
Implement the ticket following the plan. Match the existing code style and conventions.
Make the smallest change that fully solves the ticket. Run the project's build or linter if one exists.
If you receive review comments or test failures, address every one of them.
Finish with a short summary of what you changed and why.`,
  },
  {
    role: 'tester',
    name: 'Tester',
    enabled: true,
    model: 'sonnet',
    color: '#f59e0b',
    maxTurns: 40,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    systemPrompt: `${SHARED}

Role: QA Engineer.
Verify the change works. Find the project's test runner and run the relevant tests.
Add or update tests that cover the new behavior when the project has a test suite.
Do not change production code — report failures instead so the engineer can fix them.
Report passed=false if anything relevant fails.
If the change is visible in a UI and you can run it (for example with Playwright), save PNG screenshots of the
changed screens into .factory/screenshots/ in the working directory, named after what they show
(e.g. 01-settings-dark-mode.png). The PM sees them next to the review cases. Never commit that folder.`,
  },
  {
    role: 'reviewer',
    name: 'Reviewer',
    enabled: true,
    model: 'opus',
    color: '#10b981',
    maxTurns: 30,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    systemPrompt: `${SHARED}

Role: Senior Code Reviewer — the quality gate before the PM sees the work.
Review the diff for correctness, security, edge cases, readability and fit with the codebase.
Only request changes for real problems (blocker/major). Put style preferences in as nits.
Do not edit files. You may run read-only commands such as git diff, tests or the build.
A check you could not run is not a pass — say so instead of approving on assumption.
When you approve, write the PM's walkthrough: the setup to reach the change (a URL or a couple of commands),
then 2–6 test cases, each with a title, 2–5 concrete steps, and the single thing the PM should see.
Cover the happy path, the edge case most likely to break, and anything visible to users.`,
  },
];

export const DEFAULT_PROJECT_ID = 'default';

export const DEFAULT_SETTINGS: Settings = {
  mode: 'mock',
  projects: [
    {
      id: DEFAULT_PROJECT_ID, name: 'My project', keyPrefix: 'FAC', color: '#6366f1',
      repoPath: '', baseBranch: 'main', worktreesDir: '', mergeStrategy: 'local-merge',
      previewCommand: 'npm run dev -- --port $PORT', previewPath: '/',
    },
  ],
  defaultProjectId: DEFAULT_PROJECT_ID,
  repoPath: '',
  baseBranch: 'main',
  worktreesDir: '',
  concurrency: 2,
  maxLoops: 3,
  gates: { plan: false, merge: true },
  mergeStrategy: 'local-merge',
  budgetPerTicketUsd: 5,
  connectors: {
    github: { enabled: false, token: '', repo: '', label: 'factory' },
    linear: { enabled: false, apiKey: '', teamKey: '', stateName: 'Todo' },
    jira: { enabled: false, baseUrl: '', email: '', token: '', jql: 'labels = factory AND statusCategory != Done' },
  },
  ciGate: { enabled: true, pollSeconds: 30, mergeMethod: 'squash', maxWaitMinutes: 60 },
  watchdog: { enabled: true, stallMinutes: 10, maxNudges: 2 },
  harvest: { enabled: false, accountId: '', token: '', autoTimer: true },
  notifications: {
    enabled: true,
    macos: true,
    browser: true,
    slack: { enabled: false, webhookUrl: '' },
    events: { needsYou: true, ciFailed: true, shipped: true, failed: true, stuck: true },
    quietHours: { enabled: false, from: '18:00', to: '08:00' },
  },
  reports: { dailySlack: false, dailyTime: '08:45' },
  scoper: { model: 'sonnet' },
};
