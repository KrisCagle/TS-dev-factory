// Mirror of server/src/types.ts

export type Stage =
  | 'backlog'            // PM's staging area — agents never touch it
  | 'ready'              // queued for the factory; the scheduler picks from here
  | 'planning'
  | 'coding'
  | 'testing'
  | 'reviewing'
  | 'ci'                 // PR open, waiting for required checks to go green
  | 'awaiting_approval'  // a PM gate: approve the plan, or approve the final change
  | 'done'
  | 'failed';

export const STAGES: Stage[] = [
  'backlog', 'ready', 'planning', 'coding', 'testing', 'reviewing', 'ci', 'awaiting_approval', 'done', 'failed',
];

export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export type TicketSource = 'local' | 'github' | 'linear' | 'jira';
export type AgentRole = 'planner' | 'coder' | 'tester' | 'reviewer';
export type Gate = 'plan' | 'merge';

export interface Plan {
  summary: string;
  steps: string[];
  risks: string[];
  files: string[];
}

export interface TestReport {
  passed: boolean;
  summary: string;
  failures: string[];
}

export interface ReviewComment {
  file?: string;
  line?: number;
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  comment: string;
}

export interface ReviewCase {
  title: string;
  steps: string[];
  expect: string;
}

/** What the PM checks before signing off: how to set up, then one case per screen. */
export interface Walkthrough {
  setup: string[];
  cases: ReviewCase[];
}

export interface Review {
  verdict: 'approve' | 'request_changes';
  summary: string;
  comments: ReviewComment[];
  walkthrough?: Walkthrough;
}

export type CheckState = 'pending' | 'success' | 'failure' | 'none';

export interface CiCheck {
  name: string;
  state: CheckState;
  url?: string;
}

export interface CiStatus {
  state: CheckState;
  checks: CiCheck[];
  sha?: string;
  since: number;        // when we started waiting on this commit
  updatedAt: number;
}

export interface HarvestTimer {
  entryId: number;
  startedAt: number;
  notes: string;
}

export interface PmNote {
  id: string;
  text: string;
  ts: number;
}

export interface Ticket {
  id: string;
  key: string;               // FAC-12, GH-34, ENG-101, PROJ-7
  title: string;
  description: string;
  source: TicketSource;
  externalId?: string;
  externalUrl?: string;
  priority: Priority;
  labels: string[];
  stage: Stage;
  gate?: Gate;               // set while stage === 'awaiting_approval'
  activeAgent?: AgentRole;
  branch?: string;
  worktree?: string;
  plan?: Plan;
  testReport?: TestReport;
  review?: Review;
  diff?: string;
  notes: PmNote[];           // PM instructions, fed to every agent prompt
  iterations: number;        // code → test/review loops
  costUsd: number;
  tokens: number;
  error?: string;
  prUrl?: string;
  prNumber?: number;
  ci?: CiStatus;
  harvest?: { projectId?: number; taskId?: number; timer?: HarvestTimer; loggedHours: number };
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  order: number;             // manual ordering within a column
}

export interface AgentConfig {
  role: AgentRole;
  name: string;
  enabled: boolean;
  model: string;
  systemPrompt: string;
  allowedTools: string[];
  maxTurns: number;
  color: string;
}

export interface ConnectorSettings {
  github: { enabled: boolean; token: string; repo: string; label: string };
  linear: { enabled: boolean; apiKey: string; teamKey: string; stateName: string };
  jira: { enabled: boolean; baseUrl: string; email: string; token: string; jql: string };
}

export interface HarvestSettings {
  enabled: boolean;
  accountId: string;
  token: string;
  projectId?: number;
  taskId?: number;
  autoTimer: boolean;      // start a timer when you open a ticket that needs you, stop when you decide
}

export interface Settings {
  mode: 'live' | 'mock';
  repoPath: string;
  baseBranch: string;
  worktreesDir: string;
  concurrency: number;
  maxLoops: number;
  gates: { plan: boolean; merge: boolean };
  mergeStrategy: 'local-merge' | 'pull-request' | 'none';
  budgetPerTicketUsd: number;
  connectors: ConnectorSettings;
  ciGate: { enabled: boolean; pollSeconds: number; mergeMethod: 'squash' | 'merge' | 'rebase'; maxWaitMinutes: number };
  watchdog: { enabled: boolean; stallMinutes: number; maxNudges: number };
  harvest: HarvestSettings;
}

// ---------------------------------------------------------------- attention (the PM's inbox)

export type AttentionKind = 'decision' | 'review' | 'error' | 'todo';

/** Every decision comes with the reasoning the PM needs to make it quickly. */
export interface DecisionBrief {
  recommend: string;
  clearsWhen: string;
  whyNow: string;
  ifItWaits: string;
}

export interface AttentionOption {
  id: string;
  label: string;
  primary?: boolean;
  needsText?: boolean;   // e.g. "send back" requires feedback
}

export interface CaseVerdict {
  verdict: 'approved' | 'feedback';
  feedback?: string;
}

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  ticketId?: string;
  key: string;              // dedupe/supersede key, e.g. "merge:<ticketId>"
  title: string;
  body?: string;
  brief?: DecisionBrief;
  options?: AttentionOption[];
  review?: Walkthrough & { summary: string };
  status: 'open' | 'held' | 'resolved' | 'dismissed';
  heldReason?: string;
  resolution?: { option?: string; text?: string; verdicts?: CaseVerdict[]; notes?: string; at: number };
  createdAt: number;
  updatedAt: number;
}

export type LogKind = 'status' | 'text' | 'tool' | 'result' | 'error' | 'pm';

export interface LogEvent {
  id: string;
  ticketId: string;
  agent?: AgentRole | 'pm' | 'factory';
  kind: LogKind;
  text: string;
  ts: number;
}

export interface DB {
  seq: number;
  tickets: Ticket[];
  agents: AgentConfig[];
  settings: Settings;
  logs: LogEvent[];
  attention: AttentionItem[];
}
