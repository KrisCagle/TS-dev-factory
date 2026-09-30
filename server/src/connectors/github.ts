import type { CiCheck, CheckState, Priority, Settings } from '../types.js';
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

interface GhPull { number: number; html_url: string; state: string; merged: boolean; head: { sha: string } }
interface GhCheckRuns { check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string }> }
interface GhCombined { state: string; statuses: Array<{ context: string; state: string; target_url: string | null }> }

function runState(status: string, conclusion: string | null): CheckState {
  if (status !== 'completed') return 'pending';
  return conclusion && ['success', 'neutral', 'skipped'].includes(conclusion) ? 'success' : 'failure';
}

function statusState(state: string): CheckState {
  return state === 'success' ? 'success' : state === 'pending' ? 'pending' : 'failure';
}

/** Roll individual checks up: any failure fails, any pending waits, none at all is "none". */
export function rollUp(checks: CiCheck[]): CheckState {
  if (!checks.length) return 'none';
  if (checks.some((c) => c.state === 'failure')) return 'failure';
  if (checks.some((c) => c.state === 'pending')) return 'pending';
  return 'success';
}

export interface GithubExtras {
  createPR(s: Settings, head: string, base: string, title: string, body: string): Promise<{ url: string; number: number }>;
  findPR(s: Settings, head: string): Promise<{ url: string; number: number } | undefined>;
  prChecks(s: Settings, prNumber: number): Promise<{ sha: string; state: CheckState; checks: CiCheck[]; merged: boolean; closed: boolean }>;
  mergePR(s: Settings, prNumber: number, method: 'squash' | 'merge' | 'rebase', title: string): Promise<void>;
}

export const github: Connector & GithubExtras = {
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
    const pr = await http<GhPull>(api(s, '/pulls'), { method: 'POST', headers: headers(s), json: { title, head, base, body } });
    return { url: pr.html_url, number: pr.number };
  },

  async findPR(s, head) {
    const owner = s.connectors.github.repo.split('/')[0];
    const prs = await http<GhPull[]>(api(s, `/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`), { headers: headers(s) });
    return prs[0] ? { url: prs[0].html_url, number: prs[0].number } : undefined;
  },

  async prChecks(s, prNumber) {
    const pr = await http<GhPull>(api(s, `/pulls/${prNumber}`), { headers: headers(s) });
    const sha = pr.head.sha;
    const [runs, combined] = await Promise.all([
      http<GhCheckRuns>(api(s, `/commits/${sha}/check-runs?per_page=100`), { headers: headers(s) }),
      http<GhCombined>(api(s, `/commits/${sha}/status`), { headers: headers(s) }),
    ]);
    const checks: CiCheck[] = [
      ...runs.check_runs.map((r) => ({ name: r.name, state: runState(r.status, r.conclusion), url: r.html_url })),
      ...combined.statuses.map((st) => ({ name: st.context, state: statusState(st.state), url: st.target_url ?? undefined })),
    ];
    return { sha, state: rollUp(checks), checks, merged: pr.merged, closed: pr.state === 'closed' };
  },

  async mergePR(s, prNumber, method, title) {
    await http(api(s, `/pulls/${prNumber}/merge`), { method: 'PUT', headers: headers(s), json: { merge_method: method, commit_title: title } });
  },

  async test(s) {
    const r = await http<{ full_name: string; open_issues_count: number }>(api(s, ''), { headers: headers(s) });
    return `Connected to ${r.full_name} (${r.open_issues_count} open issues/PRs)`;
  },
};
