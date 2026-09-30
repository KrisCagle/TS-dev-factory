import type { Priority, Settings } from '../types.js';
import { http, type Connector } from './types.js';

const base = (s: Settings) => s.connectors.jira.baseUrl.replace(/\/$/, '');
const headers = (s: Settings) => ({
  Authorization: `Basic ${Buffer.from(`${s.connectors.jira.email}:${s.connectors.jira.token || process.env.JIRA_TOKEN || ''}`).toString('base64')}`,
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

async function transitionTo(s: Settings, key: string, category: 'indeterminate' | 'done') {
  const r = await http<{ transitions: Array<{ id: string; to: { statusCategory: { key: string } } }> }>(`${base(s)}/rest/api/3/issue/${key}/transitions`, { headers: headers(s) });
  const tr = r.transitions.find((t) => t.to.statusCategory.key === category);
  if (tr) await http(`${base(s)}/rest/api/3/issue/${key}/transitions`, { method: 'POST', headers: headers(s), json: { transition: { id: tr.id } } });
}

export const jira: Connector = {
  source: 'jira',
  label: 'Jira',
  isEnabled: (s) => s.connectors.jira.enabled && !!s.connectors.jira.baseUrl,

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
    if (stage === 'planning' || stage === 'coding') await transitionTo(s, t.externalId, 'indeterminate');
    if (stage === 'done') await transitionTo(s, t.externalId, 'done');
  },

  async test(s) {
    const r = await http<{ displayName: string }>(`${base(s)}/rest/api/3/myself`, { headers: headers(s) });
    return `Connected to Jira as ${r.displayName}`;
  },
};
