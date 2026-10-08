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
  screenshot?: string;     // artifact name that illustrates this case
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

/** A screenshot or other file attached to a ticket (shown in the review walkthrough). */
export interface Artifact {
  id: string;
  name: string;
  file: string;            // stored under the factory data dir
  caseIndex?: number;      // which walkthrough case it illustrates
  caption?: string;
  createdAt: number;
}

export interface PreviewState {
  port: number;
  status: 'starting' | 'running' | 'stopped' | 'error';
  url: string;
  error?: string;
  startedAt: number;
}

/** One repo the factory works on. */
export interface Project {
  id: string;
  name: string;
  keyPrefix: string;       // ticket keys, e.g. WING-12
  color: string;
  repoPath: string;
  baseBranch: string;
  worktreesDir: string;
  mergeStrategy: 'local-merge' | 'pull-request' | 'none';
  githubRepo?: string;     // owner/repo — overrides the GitHub connector's repo
  harvestProjectId?: number;
  harvestTaskId?: number;
  previewCommand?: string; // e.g. "npm run dev -- --port $PORT"
  previewPath?: string;    // e.g. "/" or "/login"
  rules?: string;          // house rules when the repo has no CLAUDE.md we can write
}

export interface Ticket {
  id: string;
  projectId: string;
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
  artifacts?: Artifact[];
  preview?: PreviewState;
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

export type NotifyEvent = 'needsYou' | 'ciFailed' | 'shipped' | 'failed' | 'stuck';

export interface NotificationSettings {
  enabled: boolean;                 // master switch
  macos: boolean;                   // native notifications from the server (macOS only)
  browser: boolean;                 // notifications from an open factory tab
  slack: { enabled: boolean; webhookUrl: string };
  events: Record<NotifyEvent, boolean>;
  quietHours: { enabled: boolean; from: string; to: string }; // "18:00" → "08:00"
}

export interface Settings {
  mode: 'live' | 'mock';
  projects: Project[];
  defaultProjectId: string;
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
  notifications: NotificationSettings;
  reports: { dailySlack: boolean; dailyTime: string; lastSent?: string };
  scoper: { model: string };
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
  seqs?: Record<string, number>; // last ticket number per key prefix
  tickets: Ticket[];
  agents: AgentConfig[];
  settings: Settings;
  logs: LogEvent[];
  attention: AttentionItem[];
}

// ---------------------------------------------------------------- lead scouts (mirror of server/src/leads/types.ts)

export type LeadStatus = 'new' | 'reviewing' | 'contacted' | 'won' | 'passed';
export const LEAD_STATUSES: LeadStatus[] = ['new', 'reviewing', 'contacted', 'won', 'passed'];

/** One way the agency makes money, and the signals that someone needs it. */
export interface ServiceLine {
  id: string;               // e.g. "rescue"
  name: string;             // e.g. "Rescue Projects"
  enabled: boolean;
  pitch: string;            // one line: what you do for these buyers (feeds the classifier and outreach angle)
  keywords: string[];       // phrases that suggest this need ("developer disappeared", "outgrew bubble")
  weight: number;           // 0.5–1.5: how much you want this kind of work
}

/** Who you are and what you want. Lives in the data folder, never in the repo. */
export interface LeadProfile {
  agencyName: string;
  about: string;            // a sentence or two the classifier uses for fit
  lines: ServiceLine[];
  excludeKeywords: string[]; // drop items that mention these ("unpaid", "equity only", "rev share")
  sources: {
    hackernews: { enabled: boolean; queries: string[] };
    reddit: { enabled: boolean; subreddits: string[]; queries: string[] };
  };
  schedule: { enabled: boolean; everyHours: number };
  inboxThreshold: number;   // leads scoring at or above this go to the Needs you inbox
  maxAgeDays: number;       // ignore posts older than this
  model: string;            // classifier model in live mode
}

/** What a source hands back before classification. */
export interface RawItem {
  source: string;           // "hackernews" | "reddit" | …
  externalId: string;       // stable id within the source, for dedupe
  url: string;
  title: string;
  text: string;
  author?: string;
  postedAt: number;
  where?: string;           // e.g. "r/startups" or "Ask HN"
}

export interface Classification {
  isLead: boolean;
  lineId?: string;
  confidence: number;       // 0–1
  company?: string;
  summary: string;          // what they need, in one sentence
  angle: string;            // suggested opening line for outreach
  budgetHint?: 'none' | 'low' | 'mid' | 'high';
}

export interface LeadNote {
  id: string;
  text: string;
  ts: number;
}

export interface Lead {
  id: string;
  dedupeKey: string;        // source:externalId
  source: string;
  where?: string;
  url: string;
  title: string;
  excerpt: string;
  author?: string;
  company?: string;
  lineId?: string;
  summary: string;
  angle: string;
  confidence: number;
  budgetHint?: Classification['budgetHint'];
  score: number;            // 0–100
  status: LeadStatus;
  notes: LeadNote[];
  ticketId?: string;        // set when won → a ticket was created
  postedAt: number;
  foundAt: number;
  updatedAt: number;
}

export interface ScoutRun {
  id: string;
  startedAt: number;
  finishedAt?: number;
  fetched: number;
  candidates: number;       // passed the keyword pre-filter
  created: number;
  errors: string[];
}

export interface LeadsDB {
  leads: Lead[];
  runs: ScoutRun[];
  /** Everything we've already looked at, so a rejected post isn't classified twice. */
  seen: Record<string, number>;
}

export interface ScoutStatus {
  running: boolean;
  lastRun?: ScoutRun;
  nextRunAt?: number;
  sources: Array<{ id: string; label: string; enabled: boolean }>;
}
