import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Orchestrator } from './orchestrator.js';
import type { Pipelines } from './pipelines.js';
import type { Scarif } from './scarif.js';
import type { SessionManager } from './sessions.js';
import type { Store } from './store.js';
import type { AssistantTurn, AttentionItem, Priority, Project } from './types.js';

/**
 * The assistant you talk to (by voice or typing). It's a dispatcher: it answers in a sentence or two,
 * and does things by calling the factory — start a session in a repo, start a pipeline, add a ticket,
 * read your queue, answer a decision. Replies are written to be spoken: no code, no tables.
 *
 * Live mode uses a small Claude model with the factory's tools; simulated mode understands the
 * common requests with plain pattern matching, so voice works with no API key at all.
 */

export interface Deps {
  store: Store;
  orch: Orchestrator;
  sessions: SessionManager;
  pipelines: Pipelines;
  scarif: Scarif;
}

const SYSTEM = `You are the voice assistant of the user's developer factory. The user is a project manager talking to you, often by voice.
- Answer in one to three short spoken sentences. No code, no Markdown, no lists, no URLs read aloud.
- You are a dispatcher: do things with your tools instead of explaining how. Real coding happens in sessions (start_session) or pipelines (start_pipeline), never by you.
- For anything bigger than one ticket ("build the onboarding flow"), start a pipeline. For a concrete task in a repo, start a session. For "add a ticket", create a ticket.
- When you act, say what you did and what happens next. When you need a choice, ask one short question.`;

/** Find the project a sentence names (by name or key prefix), else the default. */
export function projectIn(text: string, projects: Project[], fallback: Project): Project {
  const t = text.toLowerCase();
  return projects.find((p) => p.name && t.includes(p.name.toLowerCase()))
    ?? projects.find((p) => p.keyPrefix && new RegExp(`\\b${p.keyPrefix.toLowerCase()}\\b`).test(t))
    ?? fallback;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export class Assistant {
  constructor(private d: Deps) {}

  turns() {
    return this.d.store.assistantTurns();
  }

  clear() {
    this.d.store.clearAssistant();
  }

  async ask(text: string): Promise<AssistantTurn> {
    const said = text?.trim();
    if (!said) throw Object.assign(new Error('Say or type something first.'), { status: 400 });
    this.d.store.addAssistantTurn({ id: randomUUID(), role: 'you', text: said, ts: Date.now() });
    const actions: string[] = [];
    let reply: string;
    try {
      reply = this.d.store.settings().mode === 'live' && process.env.FACTORY_ASSISTANT_SIMPLE !== '1'
        ? await this.claude(said, actions)
        : this.simple(said, actions);
    } catch (e) {
      reply = `That didn't work: ${e instanceof Error ? e.message : String(e)}`;
    }
    return this.d.store.addAssistantTurn({ id: randomUUID(), role: 'assistant', text: reply, actions, ts: Date.now() });
  }

  // ---------------------------------------------------------------- tools (shared by both brains)

  private open() {
    return this.d.store.attention().filter((a) => a.status === 'open');
  }

  status() {
    const ts = this.d.store.tickets();
    const by = (st: string[]) => ts.filter((t) => st.includes(t.stage)).length;
    const sessions = this.d.sessions.list();
    const live = sessions.filter((s) => s.state === 'running' || s.state === 'queued').length;
    const pipes = this.d.store.pipelines().filter((p) => p.stage !== 'done');
    const fleet = this.d.scarif.fleet;
    const parts = [
      `${plural(by(['planning', 'coding', 'testing', 'reviewing']), 'ticket')} in progress, ${by(['ready'])} ready, ${by(['done'])} shipped`,
      live ? `${plural(live, 'session')} working` : '',
      pipes.length ? `${plural(pipes.length, 'pipeline')} open` : '',
      by(['remote']) ? `${by(['remote'])} on Scarif` : '',
      fleet.state === 'ready' && fleet.workers.length ? `${plural(fleet.workers.length, 'droid')} busy` : '',
    ].filter(Boolean);
    const needs = this.open().length;
    return `${parts.join(', ')}. ${needs ? `${plural(needs, 'thing')} need${needs === 1 ? 's' : ''} you.` : 'Nothing needs you.'}`;
  }

  queue(limit = 3) {
    const items = this.open();
    if (!items.length) return 'Your queue is clear.';
    const top = items.slice(0, limit).map((a, i) => `${i + 1}: ${spoken(a.title)}`).join('. ');
    return `${plural(items.length, 'item')} need${items.length === 1 ? 's' : ''} you. ${top}.`;
  }

  createTicket(input: { title: string; description?: string; project?: string; priority?: Priority; start?: boolean }) {
    const s = this.d.store;
    const project = input.project ? projectIn(input.project, s.projects(), s.project()) : s.project();
    const t = s.createTicket({ title: input.title.trim().slice(0, 140), description: input.description ?? '', projectId: project.id, priority: input.priority ?? 'medium', stage: input.start === false ? 'backlog' : 'ready' });
    return t;
  }

  startSession(input: { task: string; project?: string }) {
    const s = this.d.store;
    const project = input.project ? projectIn(input.project, s.projects(), s.project()) : s.project();
    return { session: this.d.sessions.start({ projectId: project.id, prompt: input.task }), project };
  }

  startPipeline(input: { scope: string; project?: string; title?: string }) {
    const s = this.d.store;
    const project = input.project ? projectIn(input.project, s.projects(), s.project()) : s.project();
    return { pipeline: this.d.pipelines.create({ projectId: project.id, scope: input.scope, title: input.title }), project };
  }

  /** Answer the top open decision (or one about a ticket key). */
  decide(input: { which?: string; option: 'approve' | 'sendback'; text?: string }) {
    const items = this.open().filter((a) => a.kind === 'decision' || a.kind === 'permission' || a.kind === 'review');
    const key = input.which?.toUpperCase();
    const item = key ? items.find((a) => a.title.toUpperCase().includes(key)) : items[0];
    if (!item) return { done: false, text: key ? `I don't see anything waiting on ${key}.` : 'Nothing is waiting for a decision.' };
    const option = pickOption(item, input.option);
    if (!option) return { done: false, text: `“${spoken(item.title)}” needs the queue: it has choices I shouldn't guess.` };
    if (item.kind === 'review' && item.review?.cases?.length && input.option === 'approve') {
      this.d.orch.resolve(item.id, { verdicts: item.review.cases.map(() => ({ verdict: 'approved' as const })) });
    } else this.d.orch.resolve(item.id, { option, text: input.text });
    return { done: true, text: `${input.option === 'approve' ? 'Approved' : 'Sent back'}: ${spoken(item.title)}.` };
  }

  sessionsSummary() {
    const ss = this.d.sessions.list().filter((s) => !['done', 'stopped'].includes(s.state));
    if (!ss.length) return 'No sessions are open.';
    return ss.slice(0, 4).map((s) => `${spoken(s.title)} is ${s.state === 'idle' ? 'idle' : s.state}${s.report ? `, last report: ${spoken(s.report.text)}` : ''}`).join('. ') + '.';
  }

  fleetSummary() {
    const f = this.d.scarif.fleet;
    if (f.state === 'off') return 'Scarif is turned off.';
    if (f.state === 'unconfigured') return "Scarif isn't set up yet — run scarif setup.";
    if (f.state === 'error') return `I can't reach Scarif: ${f.error}`;
    const jobs = f.workers.reduce((a, w) => a + w.jobs.length, 0) + f.queued.length;
    return jobs ? `${plural(f.workers.filter((w) => w.jobs.length).length, 'droid')} working ${plural(jobs, 'job')} of yours.` : 'No droids are working on your jobs.';
  }

  // ---------------------------------------------------------------- simulated brain

  /** Pattern-matched requests: works with no model at all. */
  simple(said: string, actions: string[]): string {
    const t = said.toLowerCase().replace(/[.!?]+$/, '');
    const s = this.d.store;
    if (/^(hi|hey|hello)\b/.test(t)) return `Hi. ${this.status()}`;
    if (/(what|anything).*(need|waiting).*(me|my)|my (queue|inbox)|what'?s in (the|my) (queue|inbox)/.test(t)) return this.queue();
    if (/\b(scarif|droids?|workers?)\b/.test(t)) return this.fleetSummary();
    if (/\bsessions?\b.*\b(doing|status|open|running)\b|^(list|show) (the )?sessions/.test(t)) return this.sessionsSummary();
    if (/\b(status|how'?s it going|what'?s (happening|going on)|catch me up|update)\b/.test(t)) return this.status();

    let m = said.match(/(?:approve|ship|accept|allow)\s*(?:the\s+)?([A-Z][A-Z0-9]+-\d+)?/i);
    if (m && /^(approve|ship|accept|allow|yes,? approve)/i.test(said.trim())) {
      const r = this.decide({ which: m[1], option: 'approve' });
      if (r.done) actions.push(r.text);
      return r.text;
    }
    m = said.match(/^(?:send (?:it|that|([A-Z][A-Z0-9]+-\d+)) back|reject)\s*(?:[,:-]|because|with)?\s*(.*)$/i);
    if (m) {
      if (!m[2]?.trim()) return 'What should change? Say “send it back because …”.';
      const r = this.decide({ which: m[1], option: 'sendback', text: m[2] });
      if (r.done) actions.push(r.text);
      return r.text;
    }
    m = said.match(/(?:new|add|create|make)\s+(?:a\s+)?ticket(?:\s+(?:to|for|in|on)\s+([\w-]+))?\s*[:,-]?\s*(?:to\s+)?(.+)/i);
    if (m && m[2]?.trim()) {
      const project = m[1] ? projectIn(m[1], s.projects(), s.project()) : projectIn(said, s.projects(), s.project());
      const ticket = this.createTicket({ title: cap(m[2].trim()), project: project.name });
      actions.push(`Created ${ticket.key}`);
      return `Added ${ticket.key}, ${spoken(ticket.title)}, to ${project.name}. It's in Ready, so the agents will pick it up.`;
    }
    m = said.match(/(?:start|kick off|open|run|create)\s+(?:a\s+)?pipeline\s+(?:for|to|on)?\s*(.+)|^build\s+(.{12,})/i);
    if (m) {
      const scope = (m[1] ?? m[2]).trim();
      const { pipeline, project } = this.startPipeline({ scope: cap(scope), project: said });
      actions.push(`Started pipeline “${pipeline.title}”`);
      return `Started a pipeline for ${spoken(pipeline.title)} in ${project.name}. I'll draft the user stories and put them in your queue to validate.`;
    }
    m = said.match(/(?:start|open|spin up|dispatch)\s+(?:a\s+)?session\s+(?:in|on|for)\s+([\w .-]+?)\s*(?:[:,-]|to)\s*(.+)|^(?:ask|tell)\s+([\w.-]+)\s+(?:to\s+)?(.+)/i);
    if (m) {
      const where = (m[1] ?? m[3]).trim();
      const task = (m[2] ?? m[4]).trim();
      const named = s.projects().find((p) => p.name.toLowerCase() === where.toLowerCase() || p.name.toLowerCase().includes(where.toLowerCase()));
      if (named || m[1]) {
        const { session, project } = this.startSession({ task: cap(task), project: (named ?? s.project()).name });
        actions.push(`Started session “${session.title}”`);
        return `Started a session in ${project.name} to ${spoken(task)}. It'll report back here and put anything it needs in your queue.`;
      }
    }
    m = said.match(/^(?:session[:,]?\s*|have (?:a )?session\s+)(.+)/i);
    if (m) {
      const { session, project } = this.startSession({ task: cap(m[1]), project: said });
      actions.push(`Started session “${session.title}”`);
      return `Started a session in ${project.name}. It'll report back when it's done.`;
    }
    if (/^(stop|cancel|never ?mind)$/.test(t)) return 'Okay.';
    return 'I can tell you what needs you, give a status, add a ticket, start a session in a repo, start a pipeline, or approve what’s waiting. For example: “start a session in my project to fix the login bug”.';
  }

  // ---------------------------------------------------------------- live brain

  private async claude(said: string, actions: string[]): Promise<string> {
    const s = this.d.store.settings();
    const projects = this.d.store.projects();
    const text = (x: string) => ({ content: [{ type: 'text' as const, text: x }] });
    const server = createSdkMcpServer({
      name: 'factory',
      version: '1.0.0',
      tools: [
        tool('status', 'What the factory is doing right now.', {}, async () => text(this.status())),
        tool('list_queue', 'What needs the PM, newest first.', {}, async () => text(this.open().slice(0, 10).map((a) => `- [${a.kind}] ${a.title}${a.options ? ` (options: ${a.options.map((o) => o.label).join(' / ')})` : ''}`).join('\n') || 'Queue is clear.')),
        tool('list_sessions', 'Open Claude Code sessions and their last reports.', {}, async () => text(this.sessionsSummary())),
        tool('scarif_fleet', 'Scarif droids working the PM’s jobs.', {}, async () => text(this.fleetSummary())),
        tool('create_ticket', 'Add a ticket to the board (Ready unless start=false).', { title: z.string(), description: z.string().optional(), project: z.string().optional(), priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(), start: z.boolean().optional() }, async (a) => {
          const t = this.createTicket(a);
          actions.push(`Created ${t.key}`);
          return text(`Created ${t.key} in ${this.d.store.project(t.projectId).name} (${t.stage}).`);
        }),
        tool('start_session', 'Start a Claude Code session in a project repo with a task. It works in the background and reports back.', { task: z.string().describe('What to do, in full'), project: z.string().optional() }, async (a) => {
          const { session, project } = this.startSession(a);
          actions.push(`Started session “${session.title}”`);
          return text(`Session started in ${project.name}.`);
        }),
        tool('message_session', 'Send a follow-up to an open session (by part of its title).', { session: z.string(), message: z.string() }, async (a) => {
          const target = this.d.sessions.list().find((x) => x.title.toLowerCase().includes(a.session.toLowerCase()));
          if (!target) return text('No session matches that.');
          this.d.sessions.send(target.id, a.message);
          actions.push(`Messaged “${target.title}”`);
          return text('Sent.');
        }),
        tool('start_pipeline', 'Start a delivery pipeline (stories → tickets → execution) for a bigger piece of work.', { scope: z.string(), title: z.string().optional(), project: z.string().optional() }, async (a) => {
          const { pipeline, project } = this.startPipeline(a);
          actions.push(`Started pipeline “${pipeline.title}”`);
          return text(`Pipeline started in ${project.name}; stories go to the queue for validation.`);
        }),
        tool('decide', 'Approve or send back the top waiting decision, or the one naming a ticket key.', { which: z.string().optional(), option: z.enum(['approve', 'sendback']), text: z.string().optional() }, async (a) => {
          const r = this.decide(a);
          if (r.done) actions.push(r.text);
          return text(r.text);
        }),
      ],
    });
    const history = this.turns().slice(-12, -1).map((t) => `${t.role === 'you' ? 'PM' : 'You'}: ${t.text}`).join('\n');
    const q = query({
      prompt: `${history ? `Conversation so far:\n${history}\n\n` : ''}Projects: ${projects.map((p) => p.name).join(', ')}.\nPM: ${said}`,
      options: {
        model: s.assistant.model || 'haiku',
        systemPrompt: SYSTEM,
        mcpServers: { factory: server },
        allowedTools: ['mcp__factory__*'],
        tools: [],
        maxTurns: 8,
        permissionMode: 'default',
        settingSources: [],
      },
    });
    let reply = '';
    for await (const m of q) {
      if (m.type === 'result') {
        if (m.subtype !== 'success') throw new Error(m.subtype);
        reply = m.result;
      }
    }
    return reply.trim() || 'Done.';
  }
}

function pickOption(item: AttentionItem, want: 'approve' | 'sendback') {
  const opts = item.options ?? [];
  if (item.kind === 'review' && !opts.length) return want === 'approve' ? 'approve' : 'sendback';
  if (want === 'approve') return (opts.find((o) => /^(approve|ship|allow|yes|o0)$/i.test(o.id)) ?? (opts.length && !opts[0].needsText ? opts[0] : undefined))?.id;
  return opts.find((o) => /^(sendback|deny|reject|no)$/i.test(o.id))?.id;
}

/** Make text pleasant to hear: no ticket-key dashes read as "minus", no Markdown. */
export function spoken(s: string) {
  return s.replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim();
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- local speech-to-text (optional)

/** Run a local speech-to-text command (e.g. whisper.cpp) on recorded audio. `{file}` is replaced with the audio path. */
export async function transcribe(command: string, audio: Buffer, mime: string): Promise<string> {
  if (!command.trim()) throw Object.assign(new Error('No local speech-to-text command is set.'), { status: 400 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-voice-'));
  const ext = mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm';
  const input = path.join(dir, `take.${ext}`);
  fs.writeFileSync(input, audio);
  const run = (cmd: string) => new Promise<string>((resolve, reject) => {
    execFile('/bin/sh', ['-c', cmd], { timeout: 120_000, env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin` } }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).slice(0, 400))) : resolve(stdout)));
  });
  try {
    let file = input;
    if (ext !== 'wav') {
      // whisper.cpp wants 16 kHz mono WAV
      const wav = path.join(dir, 'take.wav');
      await run(`ffmpeg -loglevel error -y -i '${input}' -ar 16000 -ac 1 '${wav}'`);
      file = wav;
    }
    const out = await run(command.replace(/\{file\}/g, `'${file}'`));
    return out.replace(/\[[\d:.\s>-]+\]/g, '').replace(/\s+/g, ' ').trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
