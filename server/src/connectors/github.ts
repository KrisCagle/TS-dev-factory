import type { Priority, Settings } from '../types.js';
import { http, type Connector } from './types.js';

const api = (s: Settings, p: string) => `https://api.github.com/repos/${s.connectors.github.repo}${p}`;
const headers = (s: Settings) => ({ Authorization: `Bearer ${s.connectors.github.token || process.env.GITHUB_TOKEN || ''}`, 'X-GitHub-Api-Version': '2022-11-28' });

function priorityFromLabels(labels: string[]): Priority {
  const l = labels.map((x) => x.toLowerCase()).join(' ');
  if (/urgent|p0|critical/.test(l)) return 'urgent';
  if (/high|p1/.test(l)) return 'high';
  if (/low|p3/.test(l)) return 'low';
  return 'medium';
}

interface GhIssue { number: number; title: string; body: string | null; html_url: string; labels: Array<{ name: string }>; pull_request?: unknown }

export const github: Connector & { createPR(s: Settings, head: string, base: string, title: string, body: string): Promise<string> } = {
  source: 'github',
  label: 'GitHub Issues',
  isEnabled: (s) => s.connectors.github.enabled && !!s.connectors.github.repo,

  async pull(s) {
    const label = encodeURIComponent(s.connectors.github.label);
    const issues = await http<GhIssue[]>(api(s, `/issues?state=open&per_page=50${label ? `&labels=${label}` : ''}`), { headers: headers(s) });
    return issues.filter((i) => !i.pull_request).map((i) => {
      const labels = i.labels.map((l) => l.name);
      return { key: `GH-${i.number}`, title: i.title, description: i.body ?? '', priority: priorityFromLabels(labels), labels, externalId: String(i.number), externalUrl: i.html_url };
    });
  },

  async onStage(s, t, stage, message) {
    if (!t.externalId) return;
    await http(api(s, `/issues/${t.externalId}/comments`), { method: 'POST', headers: headers(s), json: { body: `🏭 **AI Dev Factory** — ${message}` } });
    if (stage === 'done' && s.mergeStrategy === 'local-merge') {
      await http(api(s, `/issues/${t.externalId}`), { method: 'PATCH', headers: headers(s), json: { state: 'closed' } });
    }
  },

  async createPR(s, head, base, title, body) {
    const pr = await http<{ html_url: string }>(api(s, '/pulls'), { method: 'POST', headers: headers(s), json: { title, head, base, body } });
    return pr.html_url;
  },

  async test(s) {
    const r = await http<{ full_name: string; open_issues_count: number }>(api(s, ''), { headers: headers(s) });
    return `Connected to ${r.full_name} (${r.open_issues_count} open issues/PRs)`;
  },
};
