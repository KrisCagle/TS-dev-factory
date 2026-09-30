// Mirror of server/src/types.ts

export type Stage =
  | 'backlog'            // PM's staging area — agents never touch it
  | 'ready'              // queued for the factory; the scheduler picks from here
  | 'planning'
  | 'coding'
  | 'testing'
  | 'reviewing'
  | 'awaiting_approval'  // a PM gate: approve the plan, or approve the final change
  | 'done'
  | 'failed';

export const STAGES: Stage[] = [
  'backlog', 'ready', 'planning', 'coding', 'testing', 'reviewing', 'awaiting_approval', 'done', 'failed',
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

export interface Review {
  verdict: 'approve' | 'request_changes';
  summary: string;
  comments: ReviewComment[];
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
}
