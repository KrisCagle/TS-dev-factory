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
  | 'manual'             // you took it over in your editor; hand it back when you're done
  | 'remote'             // running on a remote worker (Scarif); the factory tracks it
  | 'done'
  | 'failed';

export const STAGES: Stage[] = [
  'backlog', 'ready', 'planning', 'coding', 'testing', 'reviewing', 'ci', 'awaiting_approval', 'manual', 'remote', 'done', 'failed',
];

export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export type TicketSource = 'local' | 'github' | 'linear' | 'jira' | 'sentry' | 'plugin';
export type AgentRole = 'planner' | 'coder' | 'tester' | 'reviewer';
export type Gate = 'plan' | 'merge';

export interface Plan {
  summary: string;
  steps: string[];
  risks: string[];
  files: string[];
  /** The Planner's forecast for the whole ticket. */
  estimate?: Estimate;
}

export interface Estimate {
  size: 'S' | 'M' | 'L' | 'XL';
  costUsd: number;
  minutes: number;
  /** The raw forecast scaled by how this project's past forecasts turned out. */
  adjustedCostUsd?: number;
  adjustedMinutes?: number;
}

export interface TestReport {
  passed: boolean;
  summary: string;
  failures: string[];
  /** How many tests the Tester added for this change. */
  testsAdded?: number;
  /** One entry per acceptance criterion: is there a passing test or screenshot proving it? */
  criteria?: CriterionProof[];
  /** Line coverage before/after the change, when the project can measure it. */
  coverage?: CoverageReport;
}

export interface CriterionProof {
  criterion: string;
  status: 'proven' | 'unproven' | 'failed';
  /** The test name, screenshot or command output that proves it. */
  evidence?: string;
}

export interface CoverageReport {
  /** Percent of lines covered on the base branch (all files). */
  before?: number;
  /** Percent of lines covered with this change applied. */
  after?: number;
  /** Coverage of the files this change touched. */
  files?: Array<{ file: string; pct: number }>;
}

/** How safe a change looks before you sign off, with the reasons. */
export interface Confidence {
  score: number; // 0–100
  level: 'high' | 'medium' | 'low';
  reasons: Array<{ ok: boolean; text: string }>;
}

/** What happened after a ticket shipped. */
export interface ShipInfo {
  /** Commit that landed on the base branch (merge or squash commit). */
  sha?: string;
  how: 'local-merge' | 'pull-request' | 'branch' | 'simulated';
  at: number;
  smoke?: { state: 'running' | 'passed' | 'failed' | 'skipped'; output?: string; at: number };
  reverted?: { at: number; prUrl?: string; sha?: string; note?: string };
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
  smokeCommand?: string;   // run on the base branch after shipping, e.g. "npm test"
  riskyPaths?: string[];   // touching these lowers the safety score, e.g. "migrations/", "auth"
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
  confidence?: Confidence;
  ship?: ShipInfo;
  /** Why the ticket went back to the Coder, by cause. */
  loops?: Partial<Record<LoopCause, number>>;
  /** Spend per agent role. */
  costByRole?: Partial<Record<AgentRole, number>>;
  /** Tickets that must ship before this one starts. */
  dependsOn?: string[];
  /** Why a ready ticket isn't being picked up yet. */
  waitingOn?: { reason: 'dependency' | 'overlap'; keys: string[]; files?: string[] };
  /** Where the pipeline picks up next time: after a hand-back from your editor, or after an overlap wait. */
  resume?: 'code' | 'test';
  /** You took it over in your editor. */
  manual?: { since: number; from: Stage };
  /** Where this ticket's inbox item was posted in Slack. */
  slack?: { channel: string; ts: string; itemId: string };
  /** Results from plugin agents and plugin quality gates. */
  checks?: PluginCheck[];
  /** Questions you asked about this ticket, with the answers. */
  chat?: Array<{ q: string; a: string; at: number }>;
  /** The delivery pipeline this ticket came from. */
  pipelineId?: string;
  /** Work running on a remote worker (Scarif). */
  remote?: RemoteJob;
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
  jira: {
    enabled: boolean; baseUrl: string; email: string; token: string; jql: string;
    /** Project key new issues go to, e.g. "WING" (pipelines can create their tickets in Jira). */
    projectKey: string;
    /** Jira status name to move an issue to at each factory stage; empty = by status category. */
    statusMap: Partial<Record<Stage, string>>;
  };
  sentry: { enabled: boolean; baseUrl: string; org: string; project: string; token: string; query: string; webhookSecret: string; autoImport: boolean };
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
  quality: QualitySettings;
  forecast: ForecastSettings;
  /** Per plugin: on/off and its own settings. Plugins are on unless switched off here. */
  plugins?: Record<string, { enabled: boolean; config?: Record<string, unknown> }>;
  /** Approve from Slack: a Slack app connected over Socket Mode (works without a public URL). */
  slackApp: SlackAppSettings;
  /** Claude Code sessions you dispatch work to. */
  engine: EngineSettings;
  /** Scarif remote workers. */
  scarif: ScarifSettings;
  /** The assistant you talk to. */
  assistant: AssistantSettings;
}

export interface EngineSettings {
  /** Claude Code plugin folders loaded into every session (e.g. a team process plugin). */
  pluginDirs: string[];
  /** Also look for a factory-assistant checkout and load its process plugin. */
  autoDetectProcessPlugin: boolean;
  /** ask = permission requests land in your queue; acceptEdits = file edits are fine, the rest asks; bypass = never ask. */
  permissionMode: 'ask' | 'acceptEdits' | 'bypass';
  model: string;
  /** How many sessions may run a turn at once. */
  maxParallel: number;
  /** Nudge a session that stops without reporting back. */
  nudge: boolean;
  /** Load your user-level Claude Code settings and skills (~/.claude) into sessions. */
  userSettings: boolean;
}

export interface ScarifSettings {
  enabled: boolean;
  /** Empty = read ~/.scarif/cli.json (what `scarif setup` writes). */
  url: string;
  token: string;
  /** Pipelines send tickets that fit (Jira key, ≤ maxPoints, repo known) to Scarif. */
  useForPipelines: boolean;
  maxPoints: number;
  /** Give sessions Scarif's MCP tools (read-only unless writes are on). */
  sessionTools: boolean;
  allowWrites: boolean;
}

export interface AssistantSettings {
  model: string;
  /** Speak replies with the browser's built-in voices. */
  speak: boolean;
  /** Optional local speech-to-text command (e.g. whisper.cpp's whisper-cli); empty = the browser's own. */
  whisperCommand: string;
}

export interface RemoteJob {
  kind: 'scarif';
  key: string;
  workItemId?: string;
  status: string;
  url?: string;
  worker?: string;
  since: number;
  updatedAt: number;
}

// ---------------------------------------------------------------- sessions (Claude Code in your repos)

export type SessionState = 'queued' | 'running' | 'idle' | 'waiting' | 'done' | 'error' | 'interrupted' | 'stopped';
export type ReportKind = 'result' | 'review' | 'question' | 'blocked';

export interface SessionEvent {
  kind: 'you' | 'text' | 'tool' | 'result' | 'error' | 'status';
  text: string;
  ts: number;
}

export interface WorkSession {
  id: string;
  projectId: string;
  title: string;
  state: SessionState;
  /** The Claude Code session id, used to continue the conversation. */
  sdkSessionId?: string;
  /** Messages waiting for the current turn to finish. */
  inbox: string[];
  events: SessionEvent[];
  report?: { kind: ReportKind; text: string; at: number };
  pipelineId?: string;
  ticketId?: string;
  costUsd: number;
  turns: number;
  nudges: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------- delivery pipelines

export type PipelineStage = 'scope' | 'stories' | 'tickets' | 'plan' | 'execution' | 'validation' | 'done';
export const PIPELINE_STAGES: PipelineStage[] = ['scope', 'stories', 'tickets', 'plan', 'execution', 'validation', 'done'];
export type PipelineStageStatus = 'not_started' | 'running' | 'waiting' | 'approved' | 'done' | 'blocked';

export interface StoryDraft {
  id: string;
  title: string;
  /** "As a …, I want …, so that …" */
  story: string;
  criteria: string[];
}

export interface TicketDraft {
  id: string;
  title: string;
  description: string;
  criteria: string[];
  /** Agent points (1, 2, 3, 5, 8, 13). */
  points: number;
  storyIds: string[];
  /** Other drafts (by id) that must ship first. */
  dependsOn: string[];
  route?: 'local' | 'scarif';
  routeWhy?: string;
  /** Board ticket made from this draft. */
  ticketId?: string;
  jiraKey?: string;
}

export interface Pipeline {
  id: string;
  projectId: string;
  title: string;
  /** What you want built, in your words (the placeholders). */
  scope: string;
  stage: PipelineStage;
  status: Record<PipelineStage, PipelineStageStatus>;
  stories: StoryDraft[];
  tickets: TicketDraft[];
  plan?: { summary: string; waves: string[][] };
  /** Your send-back notes, newest last. */
  feedback: Array<{ stage: PipelineStage; text: string; at: number }>;
  log: Array<{ text: string; at: number }>;
  /** Create the tickets in Jira too (needs the Jira connector and a project key). */
  createInJira: boolean;
  /** Send tickets that fit to Scarif. */
  useScarif: boolean;
  costUsd: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------- the assistant

export interface AssistantTurn {
  id: string;
  role: 'you' | 'assistant';
  text: string;
  /** What the assistant did, e.g. "Started a session in WingBuddies". */
  actions?: string[];
  ts: number;
}

// ---------------------------------------------------------------- Scarif fleet

export interface ScarifJobView {
  workItemId: string;
  key: string;
  jiraKey?: string;
  summary?: string;
  status: string;
  stage?: string;
  needsHuman: boolean;
  url: string;
  repos: string[];
  updatedAt?: number;
}

export interface ScarifWorkerView {
  id: string;
  name: string;
  status: string;
  healthy?: boolean;
  lastHeartbeatAt?: number;
  load?: number;
  cpus?: number;
  diskPct?: number;
  jobs: ScarifJobView[];
}

export interface ScarifFleet {
  state: 'off' | 'unconfigured' | 'ready' | 'error';
  error?: string;
  at: number;
  url?: string;
  workers: ScarifWorkerView[];
  /** Your jobs not on a worker yet (queued). */
  queued: ScarifJobView[];
  cliInstalled: boolean;
}

export interface SlackAppSettings {
  enabled: boolean;
  botToken: string;   // xoxb-…
  appToken: string;   // xapp-… (Socket Mode)
  channel: string;    // channel ID or #name
  /** Slack user IDs allowed to approve; empty = anyone in the channel. */
  approvers: string[];
  /** The factory's address, for "Open in factory" links. */
  factoryUrl: string;
}

export interface PluginCheck {
  plugin: string;
  id: string;
  name: string;
  kind: 'role' | 'gate';
  ok: boolean;
  message?: string;
  /** Failed checks that only lower the safety score instead of sending the work back. */
  flagOnly?: boolean;
}

export interface ForecastSettings {
  /** Ask before starting work the Planner expects to cost more than this (0 = never ask). */
  approveAboveUsd: number;
}

export interface QualitySettings {
  /** Send the change back to the Coder when an acceptance criterion has no proof. Off = flag it in your review. */
  requireProof: boolean;
  /** Send it back when coverage drops by more than maxDropPct points. */
  coverage: { enabled: boolean; maxDropPct: number };
  /** Run the project's smoke command on the base branch after shipping, and offer a revert if it fails. */
  smoke: boolean;
}

// ---------------------------------------------------------------- attention (the PM's inbox)

export type AttentionKind = 'decision' | 'review' | 'error' | 'todo' | 'question' | 'permission';

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
  /** Posted by a Claude Code session (answers go back to it). */
  sessionId?: string;
  pipelineId?: string;
  projectId?: string;
  /** Where it came from, shown as a chip: "session", "pipeline", "scarif"… */
  origin?: string;
  url?: string;
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

export type LoopCause = 'tests' | 'review' | 'ci' | 'coverage' | 'proof' | 'pm';

// ---------------------------------------------------------------- gamification

export interface Achievement {
  id: string;
  icon: string;
  title: string;
  desc: string;
  /** Secret until earned. */
  hidden?: boolean;
}

export interface Quest {
  id: string;
  icon: string;
  title: string;
  goal: number;
  progress: number;
  done: boolean;
  xp: number;
}

export interface AgentCard {
  role: AgentRole;
  level: number;
  xp: number;
  tickets: number;
  /** Coder: shipped without rework. Tester: caught problems before review. Reviewer: approved first time it looked. */
  firstTry: number;
  caught: number;
  costUsd: number;
  bestStreak: number;
  streak: number;
}

export interface GameState {
  xp: number;
  earned: Array<{ id: string; at: number; ticketKey?: string }>;
  streak: { current: number; best: number; lastDay?: string };
  daily: { day: string; quests: Quest[] };
  agents: Record<AgentRole, AgentCard>;
  /** Counters behind achievements and stats. */
  counters: Record<string, number>;
  /** Projects with at least one ship. */
  shippedProjects: string[];
  /** Notable ships for the weekly highlight. */
  highlights: Array<{ ticketId: string; key: string; title: string; score: number; at: number }>;
  history: Array<{ at: number; xp: number; why: string }>;
}

export interface GameView extends GameState {
  level: number;
  title: string;
  levelFloor: number;
  nextLevelAt: number;
  achievements: Array<Achievement & { earnedAt?: number }>;
  unlocks: Array<{ id: string; icon: string; title: string; unlocked: boolean; how: string }>;
  weeklyHighlight?: GameState['highlights'][number];
}

export interface DB {
  game?: GameState;
  /** Per project: how actual cost/time compared with the Planner's forecasts. */
  calibration?: Record<string, { n: number; costRatio: number; timeRatio: number }>;
  seq: number;
  seqs?: Record<string, number>; // last ticket number per key prefix
  tickets: Ticket[];
  agents: AgentConfig[];
  settings: Settings;
  logs: LogEvent[];
  attention: AttentionItem[];
  sessions?: WorkSession[];
  pipelines?: Pipeline[];
  assistant?: AssistantTurn[];
}
