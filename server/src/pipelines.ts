import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { consolidate } from './attention.js';
import { childEnv, extractJson } from './agents/runner.js';
import { createJiraIssue, jiraReady } from './connectors/jira.js';
import { resolvePluginDirs } from './sessions.js';
import type { Scarif } from './scarif.js';
import type { Store } from './store.js';
import type { AttentionItem, CaseVerdict, Pipeline, PipelineStage, Project, StoryDraft, TicketDraft } from './types.js';
import { PIPELINE_STAGES } from './types.js';

/**
 * Delivery pipelines: a scope of work goes from your rough description to shipped tickets,
 * and you do exactly three validations — the stories, the tickets, and the finished work.
 *
 *   scope → stories (you validate) → tickets (you validate) → plan → execution → validation (you) → done
 *
 * Drafting runs as a read-only Claude session in the repo; when a team process plugin
 * (e.g. factory-assistant's) is loaded, the drafts follow its story and ticket rules.
 * Execution puts the tickets on the board — wired with their dependencies — and the
 * factory's agents (or Scarif, for tickets that fit) work them.
 */

export interface Drafter {
  stories(p: Pipeline, project: Project, feedback?: string): Promise<{ stories: StoryDraft[]; costUsd: number }>;
  tickets(p: Pipeline, project: Project, feedback?: string): Promise<{ tickets: TicketDraft[]; costUsd: number }>;
}

const POINTS = [1, 2, 3, 5, 8, 13];
const snapPoints = (n: number) => POINTS.find((p) => p >= n) ?? 13;

const STORY_SCHEMA = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, story: { type: 'string', description: 'As a …, I want …, so that …' }, criteria: { type: 'array', items: { type: 'string' } } },
        required: ['title', 'story', 'criteria'],
      },
    },
  },
  required: ['stories'],
};

const TICKET_SCHEMA = {
  type: 'object',
  properties: {
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Short id like T1, used for dependencies' },
          title: { type: 'string' },
          description: { type: 'string' },
          criteria: { type: 'array', items: { type: 'string' } },
          points: { type: 'number', description: 'Agent points: 1, 2, 3, 5, 8 or 13' },
          stories: { type: 'array', items: { type: 'string' }, description: 'Titles of the stories it serves' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'refs of tickets that must ship first' },
        },
        required: ['ref', 'title', 'description', 'criteria', 'points'],
      },
    },
  },
  required: ['tickets'],
};

/** Drafts with Claude in the project's repo (read-only), following a process plugin when one is loaded. */
export class ClaudeDrafter implements Drafter {
  constructor(private store: Store) {}

  private async run(project: Project, prompt: string, schema: Record<string, unknown>) {
    const s = this.store.settings();
    const cwd = project.repoPath && fs.existsSync(project.repoPath) ? project.repoPath : process.cwd();
    const plugins = resolvePluginDirs(s.engine.pluginDirs, s.engine.autoDetectProcessPlugin);
    const q = query({
      prompt,
      options: {
        cwd,
        model: s.engine.model || 'sonnet',
        env: childEnv(),
        allowedTools: ['Read', 'Glob', 'Grep', 'Skill'],
        disallowedTools: ['Write', 'Edit', 'MultiEdit', 'Bash'],
        permissionMode: 'default',
        maxTurns: 30,
        settingSources: s.engine.userSettings ? ['user', 'project'] : ['project'],
        plugins: plugins.map((p) => ({ type: 'local' as const, path: p })),
        outputFormat: { type: 'json_schema', schema },
      },
    });
    let structured: unknown;
    let text = '';
    let costUsd = 0;
    for await (const m of q) {
      if (m.type === 'result') {
        costUsd = m.total_cost_usd ?? 0;
        if (m.subtype !== 'success') throw new Error(`Drafting stopped: ${m.subtype}`);
        structured = m.structured_output;
        text = m.result;
      }
    }
    return { out: (structured ?? extractJson(text) ?? {}) as Record<string, unknown>, costUsd };
  }

  async stories(p: Pipeline, project: Project, feedback?: string) {
    const prompt = `You are drafting user stories for a delivery pipeline in ${project.name}.
If the create-user-stories skill (factory-process plugin) is available, follow its rules for how stories are scoped and written — but return the stories in the structured format; don't write files, docs or Jira issues.
Read the repo enough to ground the stories in how the product works today.

Scope from the PM:
"""
${p.scope}
"""
${p.stories.length && feedback ? `\nYour previous draft:\n${p.stories.map((s) => `- ${s.title}: ${s.story}`).join('\n')}\n\nThe PM sent it back: ${feedback}\n` : ''}
Write 2–8 stories. Each: a short title, "As a …, I want …, so that …", and 2–5 observable acceptance criteria.`;
    const { out, costUsd } = await this.run(project, prompt, STORY_SCHEMA);
    const list = Array.isArray(out.stories) ? (out.stories as Array<Record<string, unknown>>) : [];
    return { stories: list.map((x) => ({ id: randomUUID().slice(0, 8), title: String(x.title ?? ''), story: String(x.story ?? ''), criteria: (x.criteria as string[] ?? []).map(String) })).filter((x) => x.title), costUsd };
  }

  async tickets(p: Pipeline, project: Project, feedback?: string) {
    const prompt = `You are breaking approved user stories into tickets for ${project.name}.
If the create-tickets-from-stories skill (factory-process plugin) is available, follow its rules for slicing, acceptance criteria and agent points — but return the tickets in the structured format; don't write files or Jira issues.
Read the repo to name the real files and components involved.

Stories:
${p.stories.map((s) => `- ${s.title}: ${s.story}\n  Criteria: ${s.criteria.join('; ')}`).join('\n')}
${p.tickets.length && feedback ? `\nYour previous tickets:\n${p.tickets.map((t) => `- ${t.title} (${t.points} pts)`).join('\n')}\n\nThe PM sent them back: ${feedback}\n` : ''}
Each ticket is one PR an agent can finish alone: a title, a description (context + the files involved), observable acceptance criteria, agent points (1–13; split anything bigger), the stories it serves, and dependencies by ref.`;
    const { out, costUsd } = await this.run(project, prompt, TICKET_SCHEMA);
    return { tickets: toDrafts(Array.isArray(out.tickets) ? (out.tickets as Array<Record<string, unknown>>) : [], p.stories), costUsd };
  }
}

/** Raw tickets (with refs) → drafts (with ids), dependencies and story links resolved. */
export function toDrafts(raw: Array<Record<string, unknown>>, stories: StoryDraft[]): TicketDraft[] {
  const ids = new Map<string, string>();
  for (const r of raw) ids.set(String(r.ref ?? r.title), randomUUID().slice(0, 8));
  return raw.map((r) => {
    const ref = String(r.ref ?? r.title);
    const storyTitles = (r.stories as string[] | undefined ?? []).map((x) => String(x).toLowerCase());
    return {
      id: ids.get(ref)!,
      title: String(r.title ?? ''),
      description: String(r.description ?? ''),
      criteria: (r.criteria as string[] | undefined ?? []).map(String),
      points: snapPoints(Number(r.points) || 3),
      storyIds: stories.filter((s) => storyTitles.some((t) => s.title.toLowerCase().includes(t) || t.includes(s.title.toLowerCase()))).map((s) => s.id),
      dependsOn: (r.dependsOn as string[] | undefined ?? []).map((d) => ids.get(String(d))).filter((x): x is string => !!x),
    };
  }).filter((t) => t.title);
}

/** Simulated drafting: shapes the scope into stories and tickets without Claude. */
export class MockDrafter implements Drafter {
  constructor(private speed = 1) {}

  private wait() {
    return new Promise((r) => setTimeout(r, Math.max(5, 1500 * this.speed)));
  }

  async stories(p: Pipeline, _project: Project, feedback?: string) {
    await this.wait();
    const parts = p.scope.split(/\n+|(?<=[.!?])\s+/).map((x) => x.replace(/^[-*\d.)\s]+/, '').trim()).filter((x) => x.length > 8).slice(0, 5);
    const items = parts.length ? parts : [p.title];
    const stories: StoryDraft[] = items.map((x, i) => {
      const what = x.replace(/[.!?]+$/, '');
      const lower = what.charAt(0).toLowerCase() + what.slice(1);
      return {
        id: randomUUID().slice(0, 8),
        title: what.length > 60 ? `${what.slice(0, 57)}…` : what,
        story: `As a user, I want to ${lower.replace(/^(we need to|users? (?:can|should)|let users|allow users to)\s+/i, '')}, so that ${i === 0 ? 'I get the main benefit of this work' : 'the experience feels complete'}.`,
        criteria: ['It works end to end in the running app', 'Empty or invalid input shows a clear message', ...(feedback ? [`Covers the PM’s note: ${feedback.slice(0, 80)}`] : [])],
      };
    });
    return { stories, costUsd: 0 };
  }

  async tickets(p: Pipeline) {
    await this.wait();
    const raw: Array<Record<string, unknown>> = [];
    p.stories.forEach((s, i) => {
      raw.push({ ref: `T${i * 2 + 1}`, title: `Backend: ${s.title}`, description: `Data and API for “${s.title}”.\n\n${s.story}`, criteria: s.criteria.slice(0, 2), points: 3, stories: [s.title], dependsOn: [] });
      raw.push({ ref: `T${i * 2 + 2}`, title: `UI: ${s.title}`, description: `Screens for “${s.title}”.`, criteria: s.criteria, points: 5, stories: [s.title], dependsOn: [`T${i * 2 + 1}`] });
    });
    return { tickets: toDrafts(raw, p.stories), costUsd: 0 };
  }
}

/** Order tickets into waves: each wave only depends on earlier waves (cycles are broken at the end). */
export function waves(tickets: TicketDraft[]): string[][] {
  const left = new Map(tickets.map((t) => [t.id, new Set(t.dependsOn.filter((d) => tickets.some((x) => x.id === d)))]));
  const out: string[][] = [];
  while (left.size) {
    const ready = [...left].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    const wave = ready.length ? ready : [[...left.keys()][0]];
    out.push(wave);
    for (const id of wave) left.delete(id);
    for (const deps of left.values()) for (const id of wave) deps.delete(id);
  }
  return out;
}

const STAGE_LABEL: Record<PipelineStage, string> = {
  scope: 'Scope', stories: 'User stories', tickets: 'Tickets', plan: 'Plan', execution: 'Execution', validation: 'Validation', done: 'Done',
};

export class Pipelines {
  constructor(
    private store: Store,
    private drafters: { live: () => Drafter; mock: () => Drafter },
    private scarif?: Scarif,
  ) {
    store.on('ticket', (t) => { if (t.pipelineId) this.onTicket(t.pipelineId); });
  }

  list() {
    return this.store.pipelines();
  }

  private get(id: string) {
    const p = this.store.pipeline(id);
    if (!p) throw Object.assign(new Error('Pipeline not found'), { status: 404 });
    return p;
  }

  private drafter() {
    return this.store.settings().mode === 'live' ? this.drafters.live() : this.drafters.mock();
  }

  private log(p: Pipeline, text: string) {
    p.log.push({ text, at: Date.now() });
    if (p.log.length > 200) p.log.splice(0, p.log.length - 200);
  }

  private set(p: Pipeline, stage: PipelineStage, status: Pipeline['status'][PipelineStage]) {
    p.stage = stage;
    p.status[stage] = status;
    // everything before the current stage is settled
    for (const k of PIPELINE_STAGES.slice(0, PIPELINE_STAGES.indexOf(stage))) if (p.status[k] !== 'approved') p.status[k] = 'done';
    this.store.savePipeline(p);
  }

  create(input: { projectId?: string; title?: string; scope: string; createInJira?: boolean; useScarif?: boolean }) {
    const scope = input.scope?.trim();
    if (!scope) throw Object.assign(new Error('Describe what you want built first.'), { status: 400 });
    const s = this.store.settings();
    const now = Date.now();
    const p: Pipeline = {
      id: randomUUID(),
      projectId: this.store.project(input.projectId).id,
      title: input.title?.trim() || scope.split('\n')[0].slice(0, 70),
      scope,
      stage: 'scope',
      status: Object.fromEntries(PIPELINE_STAGES.map((k) => [k, 'not_started'])) as Pipeline['status'],
      stories: [],
      tickets: [],
      feedback: [],
      log: [],
      createInJira: !!input.createInJira,
      useScarif: input.useScarif ?? (s.scarif.enabled && s.scarif.useForPipelines),
      costUsd: 0,
      createdAt: now,
      updatedAt: now,
    };
    p.status.scope = 'done';
    this.log(p, 'Pipeline started.');
    this.store.savePipeline(p);
    void this.draftStories(p.id);
    return p;
  }

  private async draftStories(id: string, feedback?: string) {
    const p = this.get(id);
    p.error = undefined;
    this.set(p, 'stories', 'running');
    try {
      const r = await this.drafter().stories(p, this.store.project(p.projectId), feedback);
      const cur = this.store.pipeline(id);
      if (!cur) return;
      if (!r.stories.length) throw new Error('The drafter returned no stories — add detail to the scope and retry.');
      cur.stories = r.stories;
      cur.costUsd = +(cur.costUsd + r.costUsd).toFixed(4);
      this.log(cur, `Drafted ${r.stories.length} user stories.`);
      this.set(cur, 'stories', 'waiting');
      this.askToValidate(cur, 'stories');
    } catch (e) {
      this.fail(id, e);
    }
  }

  private async draftTickets(id: string, feedback?: string) {
    const p = this.get(id);
    p.error = undefined;
    this.set(p, 'tickets', 'running');
    try {
      const r = await this.drafter().tickets(p, this.store.project(p.projectId), feedback);
      const cur = this.store.pipeline(id);
      if (!cur) return;
      if (!r.tickets.length) throw new Error('The drafter returned no tickets — retry, or send the stories back with more detail.');
      cur.tickets = r.tickets;
      cur.costUsd = +(cur.costUsd + r.costUsd).toFixed(4);
      this.log(cur, `Broke the stories into ${r.tickets.length} tickets (${r.tickets.reduce((a, t) => a + t.points, 0)} points).`);
      this.set(cur, 'tickets', 'waiting');
      this.askToValidate(cur, 'tickets');
    } catch (e) {
      this.fail(id, e);
    }
  }

  private fail(id: string, e: unknown) {
    const p = this.store.pipeline(id);
    if (!p) return;
    p.error = e instanceof Error ? e.message : String(e);
    this.log(p, `⚠ ${p.error}`);
    this.set(p, p.stage, 'blocked');
    this.store.postAttention({
      kind: 'error', key: `pipeline:${p.id}:error`, pipelineId: p.id, projectId: p.projectId, origin: 'pipeline',
      title: `${p.title}: ${STAGE_LABEL[p.stage]} hit a problem`, body: p.error,
      options: [{ id: 'retry', label: 'Retry', primary: true }, { id: 'dismiss', label: 'Dismiss' }],
    });
  }

  private askToValidate(p: Pipeline, stage: 'stories' | 'tickets') {
    const body = stage === 'stories'
      ? p.stories.map((s, i) => `**${i + 1}. ${s.title}**\n${s.story}\n${s.criteria.map((c) => `- ${c}`).join('\n')}`).join('\n\n')
      : p.tickets.map((t, i) => `**${i + 1}. ${t.title}** · ${t.points} pts${t.dependsOn.length ? ` · after ${t.dependsOn.map((d) => p.tickets.findIndex((x) => x.id === d) + 1).join(', ')}` : ''}\n${t.criteria.map((c) => `- ${c}`).join('\n')}`).join('\n\n');
    this.store.postAttention({
      kind: 'decision',
      key: `pipeline:${p.id}:${stage}`,
      pipelineId: p.id,
      projectId: p.projectId,
      origin: 'pipeline',
      title: `${p.title}: validate the ${stage === 'stories' ? `${p.stories.length} user stories` : `${p.tickets.length} tickets`}`,
      body,
      brief: {
        recommend: stage === 'stories' ? 'Check they cover what you meant — and nothing you didn’t. Edit any of them in the Pipelines tab.' : 'Check each is small enough and the criteria are what you’d test. Points over 8 are worth splitting.',
        clearsWhen: 'You approve, or send it back with what to change.',
        whyNow: stage === 'stories' ? 'Tickets are drafted from these.' : 'Approving puts them on the board and the agents start.',
        ifItWaits: 'This pipeline stays paused here; nothing else is affected.',
      },
      options: [{ id: 'approve', label: 'Approve', primary: true }, { id: 'sendback', label: 'Send back', needsText: true }],
    });
  }

  /** Edit drafts while they wait for you. */
  edit(id: string, patch: { stories?: StoryDraft[]; tickets?: TicketDraft[]; title?: string; createInJira?: boolean; useScarif?: boolean }) {
    const p = this.get(id);
    if (patch.title?.trim()) p.title = patch.title.trim();
    if (patch.createInJira !== undefined) p.createInJira = !!patch.createInJira;
    if (patch.useScarif !== undefined) p.useScarif = !!patch.useScarif;
    if (patch.stories) {
      if (!(p.stage === 'stories' && p.status.stories === 'waiting')) throw Object.assign(new Error('Stories can only be edited while they wait for you.'), { status: 409 });
      p.stories = patch.stories.filter((s) => s.title?.trim()).map((s) => ({ id: s.id || randomUUID().slice(0, 8), title: s.title.trim(), story: s.story ?? '', criteria: (s.criteria ?? []).filter(Boolean) }));
    }
    if (patch.tickets) {
      if (!(p.stage === 'tickets' && p.status.tickets === 'waiting')) throw Object.assign(new Error('Tickets can only be edited while they wait for you.'), { status: 409 });
      const ids = new Set(patch.tickets.map((t) => t.id));
      p.tickets = patch.tickets.filter((t) => t.title?.trim()).map((t) => ({ ...t, points: snapPoints(Number(t.points) || 3), dependsOn: (t.dependsOn ?? []).filter((d) => ids.has(d) && d !== t.id), criteria: (t.criteria ?? []).filter(Boolean) }));
    }
    this.store.savePipeline(p);
    // keep the queue item's summary in step with the edits
    if (patch.stories || patch.tickets) this.askToValidate(p, p.stage as 'stories' | 'tickets');
    return p;
  }

  approve(id: string, stage?: PipelineStage) {
    const p = this.get(id);
    const at = stage ?? p.stage;
    if (p.stage !== at || p.status[at] !== 'waiting') throw Object.assign(new Error(`${STAGE_LABEL[at]} isn’t waiting for you.`), { status: 409 });
    this.closeItem(p, at);
    p.status[at] = 'approved';
    this.log(p, `You approved the ${STAGE_LABEL[at].toLowerCase()}.`);
    this.store.savePipeline(p);
    if (at === 'stories') void this.draftTickets(id);
    else if (at === 'tickets') void this.planAndExecute(id);
    else if (at === 'validation') this.set(p, 'done', 'done');
    return this.store.pipeline(id);
  }

  sendBack(id: string, text: string, stage?: PipelineStage) {
    const p = this.get(id);
    const at = stage ?? p.stage;
    const note = text?.trim();
    if (!note) throw Object.assign(new Error('Say what to change.'), { status: 400 });
    if (p.stage !== at || p.status[at] !== 'waiting') throw Object.assign(new Error(`${STAGE_LABEL[at]} isn’t waiting for you.`), { status: 409 });
    this.closeItem(p, at);
    p.feedback.push({ stage: at, text: note, at: Date.now() });
    this.log(p, `You sent the ${STAGE_LABEL[at].toLowerCase()} back: ${note}`);
    this.store.savePipeline(p);
    if (at === 'stories') void this.draftStories(id, note);
    else if (at === 'tickets') void this.draftTickets(id, note);
    return this.store.pipeline(id);
  }

  retry(id: string) {
    const p = this.get(id);
    if (p.status[p.stage] !== 'blocked') throw Object.assign(new Error('Nothing to retry.'), { status: 409 });
    const open = this.store.openAttention(`pipeline:${p.id}:error`);
    if (open) this.store.updateAttention(open.id, { status: 'dismissed' });
    const last = [...p.feedback].reverse().find((f) => f.stage === p.stage)?.text;
    if (p.stage === 'stories') void this.draftStories(id, last);
    else if (p.stage === 'tickets') void this.draftTickets(id, last);
    else if (p.stage === 'plan' || p.stage === 'execution') {
      if (p.tickets.some((t) => t.ticketId)) {
        // tickets are on the board: put failed ones back in Ready
        for (const d of p.tickets) {
          const t = d.ticketId ? this.store.ticket(d.ticketId) : undefined;
          if (t?.stage === 'failed') this.store.updateTicket(t.id, { stage: 'ready', error: undefined });
        }
        this.set(p, 'execution', 'running');
      } else void this.planAndExecute(id);
    }
    return this.store.pipeline(id);
  }

  remove(id: string) {
    this.get(id);
    this.store.deletePipeline(id);
  }

  private closeItem(p: Pipeline, stage: PipelineStage) {
    const open = this.store.openAttention(`pipeline:${p.id}:${stage}`);
    if (open) this.store.updateAttention(open.id, { status: 'resolved', resolution: { option: 'via-pipeline', at: Date.now() } });
  }

  /** Route each ticket, order them, then put them on the board. */
  private async planAndExecute(id: string) {
    const p = this.get(id);
    this.set(p, 'plan', 'running');
    const s = this.store.settings();
    const project = this.store.project(p.projectId);
    const scarifOk = p.useScarif && (s.mode === 'mock' || s.scarif.enabled);
    const jiraOk = p.createInJira && (s.mode === 'mock' || jiraReady(s));
    for (const t of p.tickets) {
      const fits = t.points <= s.scarif.maxPoints;
      const repo = !!(project.githubRepo || s.connectors.github.repo) || s.mode === 'mock';
      const keyed = jiraOk || s.mode === 'mock';
      t.route = scarifOk && fits && repo && keyed ? 'scarif' : 'local';
      t.routeWhy = t.route === 'scarif' ? `${t.points} pts, fits a droid` : !scarifOk ? 'Scarif is off for this pipeline' : !fits ? `${t.points} pts is over the ${s.scarif.maxPoints}-point limit` : !repo ? 'no GitHub repo set for the project' : 'needs a Jira key (turn on “Create in Jira”)';
    }
    const order = waves(p.tickets);
    const byId = new Map(p.tickets.map((t) => [t.id, t]));
    p.plan = {
      summary: `${p.tickets.length} tickets in ${order.length} wave${order.length > 1 ? 's' : ''}; ${p.tickets.filter((t) => t.route === 'scarif').length} on Scarif, the rest local.`,
      waves: order,
    };
    this.log(p, `Plan: ${p.plan.summary}`);
    this.store.savePipeline(p);

    // Jira first, so tickets carry their keys
    if (p.createInJira) {
      for (const t of p.tickets) {
        if (t.jiraKey) continue;
        try {
          if (s.mode === 'mock') t.jiraKey = `${(s.connectors.jira.projectKey || project.keyPrefix || 'PROJ').toUpperCase()}-${100 + p.tickets.indexOf(t)}`;
          else if (jiraOk) t.jiraKey = (await createJiraIssue(s, { summary: t.title, description: `${t.description}\n\nAcceptance criteria:\n${t.criteria.map((c) => `- ${c}`).join('\n')}`, labels: ['factory'] })).key;
        } catch (e) {
          this.log(p, `⚠ Couldn’t create “${t.title}” in Jira: ${e instanceof Error ? e.message : e}`);
          if (t.route === 'scarif') { t.route = 'local'; t.routeWhy = 'Jira issue couldn’t be created'; }
        }
      }
    }

    this.set(p, 'execution', 'running');
    // board tickets, wave by wave so dependencies already exist
    for (const wave of order) {
      for (const did of wave) {
        const d = byId.get(did)!;
        if (d.ticketId && this.store.ticket(d.ticketId)) continue;
        const ac = d.criteria.length ? `\n\n## Acceptance criteria\n${d.criteria.map((c) => `- [ ] ${c}`).join('\n')}` : '';
        const t = this.store.createTicket({
          projectId: p.projectId,
          title: d.title,
          description: `${d.description}${ac}\n\n_From the pipeline “${p.title}”._`,
          priority: 'medium',
          labels: ['pipeline'],
          stage: 'backlog',
          ...(d.jiraKey ? { externalId: d.jiraKey, source: 'jira' as const } : {}),
        });
        d.ticketId = t.id;
        this.store.updateTicket(t.id, {
          pipelineId: p.id,
          dependsOn: d.dependsOn.map((x) => byId.get(x)?.ticketId).filter((x): x is string => !!x),
          stage: d.route === 'scarif' ? 'backlog' : 'ready',
        });
      }
    }
    this.log(p, 'Tickets are on the board.');
    this.store.savePipeline(p);
    this.dispatchRemote(p);
  }

  /** Send Scarif-routed tickets whose dependencies have shipped. */
  private dispatchRemote(p: Pipeline) {
    if (!this.scarif) return;
    for (const d of p.tickets) {
      if (d.route !== 'scarif' || !d.ticketId) continue;
      const t = this.store.ticket(d.ticketId);
      if (!t || t.stage !== 'backlog') continue;
      const blocked = (t.dependsOn ?? []).some((x) => this.store.ticket(x)?.stage !== 'done');
      if (blocked) continue;
      this.scarif.enqueue(t.id).catch((e) => {
        this.log(p, `⚠ Scarif wouldn’t take ${t.key} (${e instanceof Error ? e.message : e}); running it locally.`);
        d.route = 'local';
        this.store.updateTicket(t.id, { stage: 'ready' });
        this.store.savePipeline(p);
      });
    }
  }

  /** A pipeline ticket moved: dispatch what's unblocked, and validate when everything shipped. */
  private onTicket(pipelineId: string) {
    const p = this.store.pipeline(pipelineId);
    if (!p || p.stage !== 'execution') return;
    const ts = p.tickets.map((d) => (d.ticketId ? this.store.ticket(d.ticketId) : undefined)).filter((t): t is NonNullable<typeof t> => !!t);
    if (!ts.length) return;
    this.dispatchRemote(p);
    const failed = ts.filter((t) => t.stage === 'failed');
    if (failed.length && p.status.execution !== 'blocked') {
      p.error = `${failed.map((t) => t.key).join(', ')} failed.`;
      this.log(p, `⚠ ${p.error}`);
      this.set(p, 'execution', 'blocked');
      return;
    }
    if (!failed.length && p.status.execution === 'blocked') {
      p.error = undefined;
      this.set(p, 'execution', 'running');
    }
    if (ts.every((t) => t.stage === 'done') && ts.length === p.tickets.length) this.askFinalValidation(p);
  }

  private askFinalValidation(p: Pipeline) {
    this.log(p, 'Every ticket shipped. Over to you to validate the whole thing.');
    this.set(p, 'validation', 'waiting');
    const cases = p.tickets.map((d) => {
      const t = d.ticketId ? this.store.ticket(d.ticketId) : undefined;
      const c = t?.review?.walkthrough?.cases?.[0];
      return { title: d.title, steps: c?.steps ?? ['Open the app where this lives', 'Try what the ticket describes'], expect: d.criteria[0] ?? c?.expect ?? 'It does what the ticket says' };
    });
    this.store.postAttention({
      kind: 'review',
      key: `pipeline:${p.id}:validation`,
      pipelineId: p.id,
      projectId: p.projectId,
      origin: 'pipeline',
      title: `Validate “${p.title}” end to end`,
      review: { summary: `All ${p.tickets.length} tickets shipped. Walk through the finished work once, as a whole.`, setup: ['Pull the base branch and run the app.'], cases },
      options: [{ id: 'approve', label: 'Approve', primary: true }, { id: 'sendback', label: 'Send back', needsText: true }],
    });
  }

  /** Feedback on the finished work becomes follow-up tickets. */
  private followUps(p: Pipeline, item: AttentionItem, verdicts: CaseVerdict[] = [], notes?: string, text?: string) {
    const cases = item.review?.cases ?? [];
    const asks = verdicts.map((v, i) => (v.verdict === 'feedback' && v.feedback?.trim() ? { title: `Fix: ${cases[i]?.title ?? 'case'}`, body: v.feedback.trim() } : null)).filter(Boolean) as Array<{ title: string; body: string }>;
    if (notes?.trim()) asks.push({ title: `Follow-up: ${p.title}`, body: notes.trim() });
    if (text?.trim() && !asks.length) asks.push({ title: `Follow-up: ${p.title}`, body: text.trim() });
    for (const a of asks) {
      const t = this.store.createTicket({ projectId: p.projectId, title: a.title.slice(0, 120), description: `${a.body}\n\n_Feedback from validating the pipeline “${p.title}”._`, labels: ['pipeline', 'follow-up'], stage: 'ready', priority: 'high' });
      this.store.updateTicket(t.id, { pipelineId: p.id });
      p.tickets.push({ id: randomUUID().slice(0, 8), title: t.title, description: a.body, criteria: [], points: 2, storyIds: [], dependsOn: [], route: 'local', routeWhy: 'follow-up from your validation', ticketId: t.id });
    }
    p.feedback.push({ stage: 'validation', text: asks.map((a) => a.body).join(' · '), at: Date.now() });
    this.log(p, `You sent the finished work back; ${asks.length} follow-up ticket${asks.length === 1 ? '' : 's'} on the board.`);
    this.set(p, 'execution', 'running');
  }

  /** Answers from the queue. Returns false when the item isn't a pipeline's. */
  resolve(item: AttentionItem, input: { option?: string; text?: string; verdicts?: CaseVerdict[]; notes?: string }) {
    if (!item.pipelineId || !item.key.startsWith('pipeline:')) return false;
    const p = this.store.pipeline(item.pipelineId);
    const stage = item.key.split(':')[2] as PipelineStage | 'error';
    const done = (option?: string) => this.store.updateAttention(item.id, { status: 'resolved', resolution: { option: option ?? input.option, text: input.text, verdicts: input.verdicts, notes: input.notes, at: Date.now() } });
    if (!p) { done(); return true; }
    if (stage === 'error') {
      done();
      if (input.option === 'retry') this.retry(p.id);
      return true;
    }
    if (stage === 'validation') {
      if (input.verdicts) {
        const { allApproved } = consolidate(item, input.verdicts, input.notes);
        done(allApproved ? 'approve' : 'sendback');
        if (allApproved) { p.status.validation = 'approved'; this.log(p, 'You validated the finished work.'); this.set(p, 'done', 'done'); }
        else this.followUps(p, item, input.verdicts, input.notes);
      } else {
        done();
        if (input.option === 'approve') { p.status.validation = 'approved'; this.set(p, 'done', 'done'); }
        else this.followUps(p, item, [], undefined, input.text);
      }
      return true;
    }
    if (input.option === 'sendback' && !input.text?.trim()) throw Object.assign(new Error('Say what to change.'), { status: 400 });
    if (p.stage !== stage || p.status[stage] !== 'waiting') { done(); return true; } // stale item
    done();
    if (input.option === 'approve') this.approve(p.id, stage);
    else this.sendBack(p.id, input.text ?? '', stage);
    return true;
  }
}
