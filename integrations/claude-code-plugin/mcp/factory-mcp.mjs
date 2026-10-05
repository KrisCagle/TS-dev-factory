#!/usr/bin/env node
/**
 * AI Dev Factory MCP server — lets Claude (Code, Desktop, Cowork) run the factory:
 * create and draft tickets, check status, answer the inbox, ask a ticket, read reports.
 *
 * Zero dependencies: speaks MCP (JSON-RPC 2.0 over stdio) directly and talks to a
 * running factory over its REST API. Point it at your factory with FACTORY_URL
 * (default http://localhost:4317).
 */
import { createInterface } from 'node:readline';

const BASE = (process.env.FACTORY_URL || 'http://localhost:4317').replace(/\/$/, '');
const VERSION = '0.2.0';

// ---------------------------------------------------------------- factory API
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`Can't reach the factory at ${BASE} — is it running? (npm start in the ai-dev-factory folder) [${e.cause?.code ?? e.message}]`);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const state = () => api('GET', '/api/state');

/** Find a ticket by key (FAC-12, case-insensitive), id, or a unique title fragment. */
async function findTicket(ref) {
  const s = await state();
  const r = String(ref ?? '').trim();
  const t = s.tickets.find((x) => x.key.toLowerCase() === r.toLowerCase() || x.id === r)
    ?? (() => {
      const hits = s.tickets.filter((x) => x.title.toLowerCase().includes(r.toLowerCase()));
      return hits.length === 1 ? hits[0] : undefined;
    })();
  if (!t) throw new Error(`No ticket matches “${r}”. Use a key like FAC-12.`);
  return { t, s };
}

function projectId(s, ref) {
  if (!ref) return undefined;
  const r = String(ref).toLowerCase();
  const p = s.settings.projects.find((x) => x.id === ref || x.name.toLowerCase() === r || x.keyPrefix.toLowerCase() === r);
  if (!p) throw new Error(`No project “${ref}”. Projects: ${s.settings.projects.map((x) => `${x.name} (${x.keyPrefix})`).join(', ')}`);
  return p.id;
}

const STAGE = {
  backlog: 'Backlog', ready: 'Ready', planning: 'Planning', coding: 'Coding', testing: 'Testing', reviewing: 'Review',
  ci: 'CI checks', awaiting_approval: 'Needs you', manual: 'With you', done: 'Shipped', failed: 'Failed',
};
const line = (t) => `${t.key} [${STAGE[t.stage] ?? t.stage}] ${t.title}${t.confidence ? ` · safety ${t.confidence.score}` : ''}${t.waitingOn ? ` · waiting on ${t.waitingOn.keys.join(', ')}` : ''}`;

// ---------------------------------------------------------------- tools
const TOOLS = [
  {
    name: 'factory_status',
    description: 'Overview of the factory: what the agents are working on, what is waiting on the PM, what shipped, and spend. Use this first.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project name or key prefix (optional)' } } },
    async run({ project }) {
      const s = await state();
      const pid = projectId(s, project);
      const ts = s.tickets.filter((t) => !pid || t.projectId === pid);
      const by = (st) => ts.filter((t) => st.includes(t.stage));
      const open = s.attention.filter((a) => a.status === 'open' && (!pid || ts.some((t) => t.id === a.ticketId)));
      const sections = [
        `Factory: ${s.factory.paused ? 'PAUSED' : `${s.factory.running.length} running`} · mode ${s.settings.mode} · spend $${s.stats.costUsd.toFixed(2)}`,
        `Waiting on you (${open.length}):\n${open.map((a) => `- ${a.title}`).join('\n') || '- nothing'}`,
        `In progress:\n${by(['planning', 'coding', 'testing', 'reviewing', 'ci']).map((t) => `- ${line(t)}`).join('\n') || '- nothing'}`,
        `Ready queue:\n${by(['ready']).map((t) => `- ${line(t)}`).join('\n') || '- empty'}`,
        `Failed:\n${by(['failed']).map((t) => `- ${line(t)} — ${t.error ?? ''}`).join('\n') || '- none'}`,
        `Shipped recently:\n${by(['done']).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, 5).map((t) => `- ${line(t)}`).join('\n') || '- none'}`,
      ];
      if (s.game) sections.push(`PM level ${s.game.level} (${s.game.title}) · ${s.game.xp} XP · ${s.game.streak.current}-day streak`);
      return sections.join('\n\n');
    },
  },
  {
    name: 'list_tickets',
    description: 'List tickets, optionally filtered by stage or project.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: { type: 'string', enum: Object.keys(STAGE) },
        project: { type: 'string' },
        limit: { type: 'number', description: 'Default 30' },
      },
    },
    async run({ stage, project, limit = 30 }) {
      const s = await state();
      const pid = projectId(s, project);
      const ts = s.tickets.filter((t) => (!stage || t.stage === stage) && (!pid || t.projectId === pid)).slice(-limit);
      return ts.length ? ts.map(line).join('\n') : 'No tickets match.';
    },
  },
  {
    name: 'get_ticket',
    description: 'Full details of one ticket: description, plan, tests and proof per acceptance criterion, review, safety score, forecast, PR.',
    inputSchema: { type: 'object', properties: { ticket: { type: 'string', description: 'Key like FAC-12' } }, required: ['ticket'] },
    async run({ ticket }) {
      const { t } = await findTicket(ticket);
      const out = [`${t.key}: ${t.title}`, `Stage: ${STAGE[t.stage] ?? t.stage} · priority ${t.priority} · cost $${t.costUsd.toFixed(2)} · ${t.iterations} rework loop(s)`];
      if (t.description) out.push(`\n${t.description}`);
      if (t.plan) out.push(`\nPlan: ${t.plan.summary}\n${t.plan.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}${t.plan.estimate ? `\nForecast: ${t.plan.estimate.size}, ~$${(t.plan.estimate.adjustedCostUsd ?? t.plan.estimate.costUsd).toFixed(2)}` : ''}`);
      if (t.testReport) {
        out.push(`\nTests: ${t.testReport.passed ? 'PASS' : 'FAIL'} — ${t.testReport.summary}`);
        for (const c of t.testReport.criteria ?? []) out.push(`  ${c.status === 'proven' ? '✓' : c.status === 'failed' ? '✗' : '?'} ${c.criterion}${c.evidence ? ` — ${c.evidence}` : ''}`);
      }
      if (t.review) out.push(`\nReview: ${t.review.verdict} — ${t.review.summary}`);
      if (t.confidence) out.push(`\nSafety ${t.confidence.score}/100 (${t.confidence.level}): ${t.confidence.reasons.map((r) => `${r.ok ? '✓' : '!'} ${r.text}`).join('; ')}`);
      if (t.prUrl) out.push(`PR: ${t.prUrl}`);
      return out.join('\n');
    },
  },
  {
    name: 'draft_ticket',
    description: 'Turn a rough idea, bug report or pasted thread into a ticket draft (title, acceptance criteria, priority) without creating it. Show the draft to the user before creating.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, project: { type: 'string' } }, required: ['text'] },
    async run({ text, project }) {
      const s = await state();
      const d = await api('POST', '/api/scope', { text, projectId: projectId(s, project) ?? s.settings.defaultProjectId });
      return `Title: ${d.title}\nPriority: ${d.priority}\nLabels: ${d.labels.join(', ') || '—'}\n\n${d.description}${d.questions?.length ? `\n\nOpen questions:\n${d.questions.map((q) => `- ${q}`).join('\n')}` : ''}`;
    },
  },
  {
    name: 'create_ticket',
    description: 'Create a ticket. Put acceptance criteria in the description under "## Acceptance criteria" as "- [ ]" items. Set ready=true to hand it to the agents now (otherwise it goes to Backlog).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        labels: { type: 'array', items: { type: 'string' } },
        project: { type: 'string' },
        ready: { type: 'boolean' },
      },
      required: ['title'],
    },
    async run({ title, description, priority, labels, project, ready }) {
      const s = await state();
      const t = await api('POST', '/api/tickets', { title, description, priority, labels, projectId: projectId(s, project), stage: ready ? 'ready' : 'backlog' });
      return `Created ${t.key}: ${t.title} (${ready ? 'sent to the agents' : 'in Backlog'}).`;
    },
  },
  {
    name: 'inbox',
    description: 'Everything waiting on the PM (sign-offs, plan approvals, escalations, failures), each with the recommendation and options.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const s = await state();
      const open = s.attention.filter((a) => a.status === 'open');
      if (!open.length) return 'Inbox zero — nothing is waiting on you.';
      return open.map((a) => {
        const t = s.tickets.find((x) => x.id === a.ticketId);
        return [`• ${a.title}${t ? ` (${t.key})` : ''}`, a.brief ? `  Recommend: ${a.brief.recommend}` : '', t?.confidence ? `  Safety: ${t.confidence.score}/100` : '', `  Options: ${(a.options ?? []).map((o) => `${o.id}${o.needsText ? ' (needs a note)' : ''}`).join(', ')}`, `  item id: ${a.id}`].filter(Boolean).join('\n');
      }).join('\n\n');
    },
  },
  {
    name: 'answer_inbox',
    description: 'Answer an inbox item for a ticket: e.g. option "ship" or "approve" to approve, "sendback" with a note to send work back, "retry", "revert". Only do this when the user has clearly decided.',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'string', description: 'Ticket key, or the inbox item id' },
        option: { type: 'string' },
        note: { type: 'string', description: 'Required for send back' },
      },
      required: ['ticket', 'option'],
    },
    async run({ ticket, option, note }) {
      const s = await state();
      let item = s.attention.find((a) => a.id === ticket && a.status === 'open');
      if (!item) {
        const { t } = await findTicket(ticket);
        item = s.attention.find((a) => a.ticketId === t.id && a.status === 'open');
        if (!item) throw new Error(`${t.key} has nothing waiting on you (stage: ${STAGE[t.stage] ?? t.stage}).`);
      }
      const valid = (item.options ?? []).map((o) => o.id);
      if (valid.length && !valid.includes(option)) throw new Error(`“${option}” isn't an option here. Choose one of: ${valid.join(', ')}`);
      await api('POST', `/api/attention/${item.id}/resolve`, { option, text: note });
      return `Done: ${option} on “${item.title}”.`;
    },
  },
  {
    name: 'add_note',
    description: 'Add a PM note to a ticket. Every agent treats notes as top priority on its next step.',
    inputSchema: { type: 'object', properties: { ticket: { type: 'string' }, note: { type: 'string' } }, required: ['ticket', 'note'] },
    async run({ ticket, note }) {
      const { t } = await findTicket(ticket);
      await api('POST', `/api/tickets/${t.id}/notes`, { text: note });
      return `Note added to ${t.key}.`;
    },
  },
  {
    name: 'ask_ticket',
    description: 'Ask a question about a ticket (why a file changed, what is left, whether tests pass, why it was sent back, what it cost).',
    inputSchema: { type: 'object', properties: { ticket: { type: 'string' }, question: { type: 'string' } }, required: ['ticket', 'question'] },
    async run({ ticket, question }) {
      const { t } = await findTicket(ticket);
      return (await api('POST', `/api/tickets/${t.id}/ask`, { question })).a;
    },
  },
  {
    name: 'move_ticket',
    description: 'Move a ticket between Backlog and Ready (Ready hands it to the agents).',
    inputSchema: { type: 'object', properties: { ticket: { type: 'string' }, to: { type: 'string', enum: ['backlog', 'ready'] } }, required: ['ticket', 'to'] },
    async run({ ticket, to }) {
      const { t } = await findTicket(ticket);
      await api('PATCH', `/api/tickets/${t.id}`, { stage: to });
      return `${t.key} moved to ${STAGE[to]}.`;
    },
  },
  {
    name: 'report',
    description: 'The daily standup or weekly report as Markdown (shipped, in progress, waiting on you, blocked, spend, Harvest hours).',
    inputSchema: { type: 'object', properties: { range: { type: 'string', enum: ['day', 'week'] }, project: { type: 'string' } } },
    async run({ range = 'day', project }) {
      const s = await state();
      const pid = projectId(s, project);
      return (await api('GET', `/api/reports?range=${range}${pid ? `&projectId=${pid}` : ''}`)).markdown;
    },
  },
  {
    name: 'catch_up',
    description: 'What happened in the factory in the last N hours.',
    inputSchema: { type: 'object', properties: { hours: { type: 'number', description: 'Default 8' } } },
    async run({ hours = 8 }) {
      const c = await api('GET', `/api/catchup?since=${Date.now() - hours * 3_600_000}`);
      const part = (title, xs, f) => (xs.length ? `\n${title}:\n${xs.map((x) => `- ${f(x)}`).join('\n')}` : '');
      return `${c.headline}${part('Waiting on you', c.needsYou, (x) => x.title)}${part('Needs a look', c.problems, (x) => `${x.key} ${x.title} — ${x.what}`)}${part('Shipped', c.shipped, (x) => `${x.key} ${x.title}`)}${part('Started', c.started, (x) => `${x.key} ${x.title} (now ${x.stage})`)}`;
    },
  },
  {
    name: 'pause_factory',
    description: 'Pause or resume the factory (paused = no new tickets are picked up).',
    inputSchema: { type: 'object', properties: { paused: { type: 'boolean' } }, required: ['paused'] },
    async run({ paused }) {
      await api('POST', '/api/factory/pause', { paused });
      return paused ? 'Factory paused.' : 'Factory resumed.';
    },
  },
];

// ---------------------------------------------------------------- MCP over stdio
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

export async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'ai-dev-factory', version: VERSION },
      instructions: 'Tools for running AI Dev Factory as its PM. Start with factory_status. Confirm with the user before approving, sending back or reverting work.',
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return fail(id, -32602, `Unknown tool ${params?.name}`);
    try {
      const text = await tool.run(params?.arguments ?? {});
      return reply(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  if (id === undefined) return; // notifications (initialized, cancelled…) need no answer
  return fail(id, -32601, `Method not found: ${method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (l) => {
  if (!l.trim()) return;
  let msg;
  try {
    msg = JSON.parse(l);
  } catch {
    return fail(null, -32700, 'Parse error');
  }
  void handle(msg);
});
