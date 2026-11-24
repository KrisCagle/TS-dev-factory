import type { Priority, Settings } from '../types.js';
import { http, type Connector } from './types.js';

// Settings first, then the environment (JIRA_SITE / JIRA_EMAIL / JIRA_API_TOKEN, the same names factory-assistant uses).
const base = (s: Settings) => (s.connectors.jira.baseUrl || process.env.JIRA_SITE || '').replace(/\/$/, '');
const headers = (s: Settings) => ({
  Authorization: `Basic ${Buffer.from(`${s.connectors.jira.email || process.env.JIRA_EMAIL || ''}:${s.connectors.jira.token || process.env.JIRA_API_TOKEN || process.env.JIRA_TOKEN || ''}`).toString('base64')}`,
});

// Atlassian Document Format → plain text
function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text') return n.text ?? '';
  const inner = (n.content ?? []).map(adfToText).join('');
  return ['paragraph', 'heading', 'listItem', 'codeBlock'].includes(n.type ?? '') ? `${inner}\n` : inner;
}
const adf = (text: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

function priority(name?: string): Priority {
  const n = (name ?? '').toLowerCase();
  if (/highest|blocker|critical/.test(n)) return 'urgent';
  if (/high/.test(n)) return 'high';
  if (/low/.test(n)) return 'low';
  return 'medium';
}

type Transition = { id: string; name?: string; to: { name?: string; statusCategory: { key: string } } };

/** Pick the transition for a stage: your mapped status name first, else the status category. */
export function pickTransition(transitions: Transition[], wanted: { status?: string; category: 'indeterminate' | 'done' }) {
  const name = wanted.status?.trim().toLowerCase();
  if (name) {
    const byName = transitions.find((t) => t.to.name?.toLowerCase() === name || t.name?.toLowerCase() === name);
    if (byName) return byName;
  }
  return transitions.find((t) => t.to.statusCategory.key === wanted.category);
}

async function transitionTo(s: Settings, key: string, category: 'indeterminate' | 'done', status?: string) {
  const r = await http<{ transitions: Transition[] }>(`${base(s)}/rest/api/3/issue/${key}/transitions`, { headers: headers(s) });
  const tr = pickTransition(r.transitions, { status, category });
  if (tr) await http(`${base(s)}/rest/api/3/issue/${key}/transitions`, { method: 'POST', headers: headers(s), json: { transition: { id: tr.id } } });
}

/** Create an issue (pipelines use this for their tickets). Returns the new key. */
export async function createJiraIssue(s: Settings, input: { summary: string; description: string; labels?: string[]; projectKey?: string }) {
  const project = input.projectKey || s.connectors.jira.projectKey;
  if (!project) throw new Error('Set a Jira project key in Settings → Connectors first.');
  const r = await http<{ key: string }>(`${base(s)}/rest/api/3/issue`, {
    method: 'POST',
    headers: headers(s),
    json: {
      fields: {
        project: { key: project },
        summary: input.summary.slice(0, 250),
        issuetype: { name: 'Task' },
        labels: (input.labels ?? []).map((l) => l.replace(/\s+/g, '-')),
        description: { type: 'doc', version: 1, content: input.description.split(/\n{2,}/).filter(Boolean).map((para) => ({ type: 'paragraph', content: [{ type: 'text', text: para }] })) },
      },
    },
  });
  return { key: r.key, url: `${base(s)}/browse/${r.key}` };
}

export const jiraReady = (s: Settings) => !!base(s) && !!(s.connectors.jira.email || process.env.JIRA_EMAIL) && !!(s.connectors.jira.token || process.env.JIRA_API_TOKEN || process.env.JIRA_TOKEN);

export const jira: Connector = {
  source: 'jira',
  label: 'Jira',
  isEnabled: (s) => s.connectors.jira.enabled && !!base(s),

  async pull(s) {
    const jql = encodeURIComponent(s.connectors.jira.jql);
    const r = await http<{ issues: Array<{ key: string; fields: { summary: string; description: unknown; labels: string[]; priority?: { name: string } } }> }>(
      `${base(s)}/rest/api/3/search/jql?jql=${jql}&maxResults=50&fields=summary,description,labels,priority`,
      { headers: headers(s) },
    );
    return r.issues.map((i) => ({
      key: i.key, title: i.fields.summary, description: adfToText(i.fields.description).trim(), priority: priority(i.fields.priority?.name),
      labels: i.fields.labels ?? [], externalId: i.key, externalUrl: `${base(s)}/browse/${i.key}`,
    }));
  },

  async onStage(s, t, stage, message) {
    if (!t.externalId) return;
    await http(`${base(s)}/rest/api/3/issue/${t.externalId}/comment`, { method: 'POST', headers: headers(s), json: { body: adf(`🏭 AI Dev Factory — ${message}`) } });
    const mapped = s.connectors.jira.statusMap?.[stage];
    if (mapped) await transitionTo(s, t.externalId, stage === 'done' ? 'done' : 'indeterminate', mapped);
    else if (stage === 'planning' || stage === 'coding' || stage === 'remote') await transitionTo(s, t.externalId, 'indeterminate');
    else if (stage === 'done') await transitionTo(s, t.externalId, 'done');
  },

  async test(s) {
    const r = await http<{ displayName: string }>(`${base(s)}/rest/api/3/myself`, { headers: headers(s) });
    return `Connected to Jira as ${r.displayName}`;
  },
};
