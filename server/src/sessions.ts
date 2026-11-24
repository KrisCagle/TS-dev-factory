import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { consolidate } from './attention.js';
import type { Store } from './store.js';
import type { AttentionItem, AttentionKind, CaseVerdict, ReportKind, ReviewCase, SessionEvent, WorkSession } from './types.js';

/**
 * Sessions: real Claude Code sessions in your repos that you dispatch work to.
 *
 * A session never waits on you. When it needs a decision it posts one to your queue
 * (post_attention) and carries on with its recommendation; when it finishes something
 * you should check, it posts a review with setup steps and test cases. Every turn ends
 * with one report line — RESULT / REVIEW / QUESTION / BLOCKED — which is what you see
 * on its card. Your answers in the queue go straight back into the conversation.
 */

export const SESSION_RULES = `You are a Claude Code session in the user's developer factory. The user is the project manager and is NOT watching this terminal.
- Never wait on the user. When you need a decision, call the post_attention tool (kind "decision", options with your recommendation first, or kind "question"), then carry on with your recommendation where that's safe. Their answer arrives later as a new message.
- When you finish work the user should validate, call post_attention with kind "review": a one-paragraph summary, the setup steps to reach the change, and 2–6 test cases (title, steps, the one thing they should see).
- Things the user must do themselves (credentials, a vendor call, a manual step) are kind "todo".
- Own your technical calls; don't ask about things you can decide.
- End every turn with exactly one line, the last line of your message:
  RESULT: <what happened, one sentence>   or   REVIEW: <what to check>   or   QUESTION: <what you asked>   or   BLOCKED: <what stops you>`;

const REPORT_RE = /^\s*(?:\*\*)?(RESULT|REVIEW|QUESTION|BLOCKED):?(?:\*\*)?:?\s*(.+)$/im;

/** The last report line in a turn's text, if any. */
export function parseReport(text: string): { kind: ReportKind; text: string } | undefined {
  const lines = text.trim().split('\n').reverse();
  for (const line of lines) {
    const m = line.match(REPORT_RE);
    if (m) return { kind: m[1].toLowerCase() as ReportKind, text: m[2].trim() };
  }
  return undefined;
}

export function titleFrom(prompt: string) {
  const first = prompt.trim().split('\n')[0].replace(/^\/\S+\s*/, (m) => m); // keep slash commands visible
  return first.length > 60 ? `${first.slice(0, 57).replace(/\s+\S*$/, '')}…` : first || 'Session';
}

/** What a session may post to your queue. */
export interface PostAttentionInput {
  kind: 'decision' | 'question' | 'review' | 'todo';
  title: string;
  body?: string;
  options?: string[];
  review?: { summary?: string; setup?: string[]; cases?: ReviewCase[] };
}

export interface PermissionAsk {
  tool: string;
  input: Record<string, unknown>;
}

/** What the factory hands a running turn. */
export interface TurnContext {
  session: WorkSession;
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  pluginDirs: string[];
  event: (e: Omit<SessionEvent, 'ts'>) => void;
  /** The SDK told us its session id (first turn). */
  sdkSession: (id: string) => void;
  postAttention: (input: PostAttentionInput) => string;
  /** Resolves true (allow) or false with a reason. */
  askPermission: (ask: PermissionAsk) => Promise<{ allow: boolean; always?: boolean; message?: string }>;
}

export interface SessionRunner {
  turn(ctx: TurnContext): Promise<{ text: string; costUsd: number }>;
}

/** Claude Code plugin folders to load: your list, plus a factory-assistant process plugin if one is found. */
export function resolvePluginDirs(dirs: string[], autoDetect: boolean, home = os.homedir()): string[] {
  const expand = (d: string) => (d.startsWith('~') ? path.join(home, d.slice(1)) : d);
  const isPlugin = (d: string) => fs.existsSync(path.join(d, '.claude-plugin', 'plugin.json'));
  const out = dirs.map(expand).filter(isPlugin);
  if (autoDetect) {
    const candidates = [
      process.env.FACTORY_PROCESS_PLUGIN,
      ...['Documents', 'workspace', 'code', 'src', 'dev', ''].map((d) => path.join(home, d, 'factory-assistant', 'process-plugin')),
    ].filter(Boolean) as string[];
    const found = candidates.find(isPlugin);
    if (found && !out.includes(found)) out.push(found);
  }
  return out;
}

interface Pending {
  resolve: (r: { allow: boolean; always?: boolean; message?: string }) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
}

const PERMISSION_TIMEOUT_MS = 30 * 60_000;

export class SessionManager {
  private running = new Map<string, AbortController>();
  private pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    private store: Store,
    private runners: { live: () => SessionRunner; mock: () => SessionRunner },
    private opts: { speed?: number } = {},
  ) {}

  list() {
    return this.store.sessions();
  }

  private mustGet(id: string) {
    const s = this.store.session(id);
    if (!s) throw Object.assign(new Error('Session not found'), { status: 404 });
    return s;
  }

  /** Start a session in a project's repo with a task. */
  start(input: { projectId?: string; prompt: string; title?: string; pipelineId?: string; ticketId?: string }) {
    const prompt = input.prompt?.trim();
    if (!prompt) throw Object.assign(new Error('Tell the session what to do.'), { status: 400 });
    const project = this.store.project(input.projectId);
    if (this.store.settings().mode === 'live' && !(project.repoPath && fs.existsSync(project.repoPath))) {
      throw Object.assign(new Error(`${project.name} has no repo folder yet — set one in Settings → Projects.`), { status: 400 });
    }
    const now = Date.now();
    const s: WorkSession = {
      id: randomUUID(),
      projectId: project.id,
      title: input.title?.trim() || titleFrom(prompt),
      state: 'queued',
      inbox: [prompt],
      events: [],
      pipelineId: input.pipelineId,
      ticketId: input.ticketId,
      costUsd: 0,
      turns: 0,
      nudges: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.store.createSession(s);
    this.pump();
    return s;
  }

  /** Send a message. If a turn is running it's picked up right after. */
  send(id: string, text: string) {
    const s = this.mustGet(id);
    const msg = text?.trim();
    if (!msg) throw Object.assign(new Error('Type a message first.'), { status: 400 });
    if (s.state === 'stopped') this.store.updateSession(id, { state: 'idle' });
    this.store.updateSession(id, { inbox: [...s.inbox, msg], state: s.state === 'running' ? 'running' : 'queued' });
    this.pump();
    return this.store.session(id);
  }

  /** Pick an interrupted session back up where it left off. */
  resume(id: string) {
    const s = this.mustGet(id);
    if (s.state === 'running') return s;
    if (s.inbox.length) {
      this.store.updateSession(id, { state: 'queued' });
      this.pump();
      return this.store.session(id);
    }
    return this.send(id, 'You were interrupted mid-turn (the factory restarted or you were stopped). Check where you left off and carry on.');
  }

  stop(id: string) {
    const s = this.mustGet(id);
    this.running.get(id)?.abort();
    for (const [pid, p] of this.pending) if (p.sessionId === id) this.settle(pid, { allow: false, message: 'The PM stopped this session.' });
    this.store.updateSession(id, { state: 'stopped', inbox: [] });
    return this.store.session(s.id);
  }

  remove(id: string) {
    this.mustGet(id);
    this.running.get(id)?.abort();
    this.store.deleteSession(id);
  }

  /** Mark finished (keeps the history). */
  finish(id: string) {
    this.mustGet(id);
    if (this.running.has(id)) throw Object.assign(new Error('It’s mid-turn — stop it first.'), { status: 409 });
    return this.store.updateSession(id, { state: 'done' });
  }

  private pump() {
    const max = Math.max(1, this.store.settings().engine.maxParallel);
    for (const s of this.store.sessions()) {
      if (this.running.size >= max) return;
      if (s.state === 'queued' && s.inbox.length && !this.running.has(s.id)) void this.runTurn(s.id);
    }
  }

  private async runTurn(id: string) {
    const s = this.store.session(id);
    if (!s) return;
    const prompt = s.inbox.join('\n\n');
    const ac = new AbortController();
    this.running.set(id, ac);
    this.store.updateSession(id, { state: 'running', inbox: [], error: undefined });
    this.store.sessionEvent(id, { kind: 'you', text: prompt });
    const settings = this.store.settings();
    const project = this.store.project(s.projectId);
    const runner = settings.mode === 'live' ? this.runners.live() : this.runners.mock();
    let text = '';
    try {
      const r = await runner.turn({
        session: this.store.session(id)!,
        prompt,
        cwd: project.repoPath || process.cwd(),
        signal: ac.signal,
        pluginDirs: resolvePluginDirs(settings.engine.pluginDirs, settings.engine.autoDetectProcessPlugin),
        event: (e) => this.store.sessionEvent(id, e),
        sdkSession: (sid) => this.store.updateSession(id, { sdkSessionId: sid }),
        postAttention: (input) => this.postFromSession(id, input),
        askPermission: (ask) => this.askPermission(id, ask),
      });
      text = r.text;
      const cur = this.store.session(id)!;
      this.store.updateSession(id, { costUsd: +(cur.costUsd + r.costUsd).toFixed(4), turns: cur.turns + 1 });
    } catch (e) {
      this.running.delete(id);
      const cur = this.store.session(id);
      if (cur && cur.state !== 'stopped') {
        const msg = e instanceof Error ? e.message : String(e);
        this.store.sessionEvent(id, { kind: 'error', text: msg });
        this.store.updateSession(id, { state: ac.signal.aborted ? 'stopped' : 'error', error: msg });
        if (!ac.signal.aborted) this.notifyError(id, msg);
      }
      this.pump();
      return;
    }
    this.running.delete(id);
    const cur = this.store.session(id);
    if (!cur || cur.state === 'stopped') return this.pump();

    const report = parseReport(text);
    if (report) {
      this.store.updateSession(id, { report: { ...report, at: Date.now() }, nudges: 0 });
      this.store.sessionEvent(id, { kind: 'result', text: `${report.kind.toUpperCase()}: ${report.text}` });
    }
    const hasMore = (this.store.session(id)?.inbox.length ?? 0) > 0;
    if (!report && !hasMore && settings.engine.nudge && cur.nudges < 1) {
      // the watchdog: a turn that ends without a report usually stopped early
      this.store.updateSession(id, {
        nudges: cur.nudges + 1,
        inbox: ['You stopped without a report line. If you are done, end with RESULT:/REVIEW:/QUESTION:/BLOCKED:. If not, carry on.'],
        state: 'queued',
      });
    } else {
      const openQ = this.store.attention().some((a) => a.sessionId === id && a.status === 'open' && a.kind !== 'review');
      this.store.updateSession(id, { state: hasMore ? 'queued' : openQ || report?.kind === 'question' ? 'waiting' : 'idle' });
    }
    this.pump();
  }

  // ---------------------------------------------------------------- the queue

  private postFromSession(id: string, input: PostAttentionInput): string {
    const s = this.store.session(id)!;
    const kind: AttentionKind = (['decision', 'question', 'review', 'todo'] as const).includes(input.kind) ? input.kind : 'question';
    const options = kind === 'decision'
      ? (input.options?.length ? input.options : ['Yes', 'No']).slice(0, 6).map((label, i) => ({ id: `o${i}`, label: String(label), primary: i === 0 }))
      : kind === 'question'
        ? [{ id: 'answer', label: 'Answer', primary: true, needsText: true }]
        : kind === 'todo'
          ? [{ id: 'done', label: 'Done', primary: true }]
          : undefined;
    const cases = (input.review?.cases ?? []).filter((c) => c?.title).map((c) => ({ title: String(c.title), steps: (c.steps ?? []).map(String), expect: String(c.expect ?? '') }));
    const item = this.store.postAttention({
      kind,
      key: `session:${id}:${++this.seq}:${Date.now()}`,
      sessionId: id,
      projectId: s.projectId,
      pipelineId: s.pipelineId,
      ticketId: undefined,
      origin: 'session',
      title: String(input.title || 'A session needs you').slice(0, 200),
      body: input.body,
      options,
      review: kind === 'review' ? { summary: input.review?.summary ?? input.body ?? input.title, setup: input.review?.setup ?? [], cases: cases.length ? cases : [{ title: 'Does it do what you asked?', steps: ['Try the change'], expect: input.title }] } : undefined,
    });
    if (kind !== 'review' && kind !== 'todo') this.store.updateSession(id, { state: this.running.has(id) ? 'running' : 'waiting' });
    return item.id;
  }

  private askPermission(id: string, ask: PermissionAsk) {
    const s = this.store.session(id)!;
    const detail = describeTool(ask.tool, ask.input);
    const item = this.store.postAttention({
      kind: 'permission',
      key: `perm:${id}:${randomUUID()}`,
      sessionId: id,
      projectId: s.projectId,
      pipelineId: s.pipelineId,
      origin: 'session',
      title: `${s.title}: allow ${ask.tool}?`,
      body: detail,
      options: [
        { id: 'allow', label: 'Allow', primary: true },
        { id: 'always', label: `Always allow ${ask.tool} here` },
        { id: 'deny', label: 'Deny' },
      ],
    });
    this.store.updateSession(id, { state: 'waiting' });
    return new Promise<{ allow: boolean; always?: boolean; message?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.store.updateAttention(item.id, { status: 'dismissed' });
        this.settle(item.id, { allow: false, message: 'No answer within 30 minutes — carry on without it and say what you skipped.' });
      }, PERMISSION_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(item.id, { resolve, timer, sessionId: id });
    });
  }

  private settle(itemId: string, r: { allow: boolean; always?: boolean; message?: string }) {
    const p = this.pending.get(itemId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(itemId);
    if (this.running.has(p.sessionId)) this.store.updateSession(p.sessionId, { state: 'running' });
    p.resolve(r);
    return true;
  }

  /** Your answer to something a session posted. Returns false when the item isn't a session's. */
  resolve(item: AttentionItem, input: { option?: string; text?: string; verdicts?: CaseVerdict[]; notes?: string }) {
    if (!item.sessionId) return false;
    const done = (option?: string) =>
      this.store.updateAttention(item.id, { status: 'resolved', resolution: { option: option ?? input.option, text: input.text, verdicts: input.verdicts, notes: input.notes, at: Date.now() } });

    if (item.kind === 'permission') {
      done();
      const allow = input.option !== 'deny';
      const settled = this.settle(item.id, { allow, always: input.option === 'always', message: allow ? undefined : input.text?.trim() || 'The PM denied this. Find another way or report BLOCKED.' });
      if (!settled) this.store.sessionEvent(item.sessionId, { kind: 'status', text: 'That permission request had already expired.' });
      return true;
    }
    const s = this.store.session(item.sessionId);
    let reply: string | undefined;
    if (item.kind === 'review') {
      const { allApproved, feedback } = consolidate(item, input.verdicts ?? [], input.notes);
      if (input.verdicts) {
        done(allApproved ? 'approve' : 'feedback');
        reply = allApproved
          ? `The PM validated your review "${item.title}": every case passed. Wrap up (merge or open the PR as the project expects) and report.`
          : `The PM reviewed "${item.title}" and wants changes.\n${feedback}`;
      } else {
        done();
        reply = input.option === 'approve' || input.option === 'ship' ? `The PM approved "${item.title}". Wrap up and report.` : `The PM wants changes to "${item.title}": ${input.text ?? ''}`;
      }
    } else if (item.kind === 'todo') {
      done('done');
      reply = `The PM did the to-do "${item.title}".${input.text ? ` Note: ${input.text}` : ''}`;
    } else {
      const label = item.options?.find((o) => o.id === input.option)?.label;
      if (item.kind === 'question' && !input.text?.trim()) throw Object.assign(new Error('Type an answer first.'), { status: 400 });
      done();
      reply = item.kind === 'question'
        ? `The PM answered your question "${item.title}": ${input.text!.trim()}`
        : `The PM decided "${item.title}": ${label ?? input.option}${input.text?.trim() ? ` — ${input.text.trim()}` : ''}`;
    }
    if (s && reply && s.state !== 'stopped') this.send(s.id, reply);
    return true;
  }

  private notifyError(id: string, msg: string) {
    const s = this.store.session(id)!;
    this.store.postAttention({
      kind: 'error', key: `session-error:${id}`, sessionId: id, projectId: s.projectId, origin: 'session',
      title: `${s.title} stopped with an error`, body: msg,
      options: [{ id: 'retry', label: 'Retry', primary: true }, { id: 'dismiss', label: 'Dismiss' }],
    });
  }

  /** Error items have their own buttons. */
  resolveError(item: AttentionItem, option?: string) {
    if (!item.key.startsWith('session-error:') || !item.sessionId) return false;
    this.store.updateAttention(item.id, { status: 'resolved', resolution: { option, at: Date.now() } });
    if (option === 'retry') this.resume(item.sessionId);
    return true;
  }

  /** Stop everything (shutdown). */
  stopAll() {
    for (const ac of this.running.values()) ac.abort();
    for (const id of [...this.pending.keys()]) this.settle(id, { allow: false, message: 'The factory is shutting down.' });
  }
}

export function describeTool(tool: string, input: Record<string, unknown>) {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  if (tool === 'Bash') return `\`\`\`\n${s('command')}\n\`\`\`${s('description') ? `\n${s('description')}` : ''}`;
  if (['Write', 'Edit', 'MultiEdit', 'Read'].includes(tool)) return s('file_path');
  if (tool === 'WebFetch') return s('url');
  return JSON.stringify(input, null, 2).slice(0, 1200);
}
