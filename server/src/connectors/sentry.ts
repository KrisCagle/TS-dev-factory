import crypto from 'node:crypto';
import type { Priority, Settings } from '../types.js';
import { http, type Connector, type ImportedTicket } from './types.js';

/**
 * Sentry → factory tickets. Unresolved issues become Backlog tickets with the error,
 * how often it happens and the stack trace, plus acceptance criteria the Tester proves.
 * When the ticket ships, the Sentry issue is resolved with a comment.
 */

const cfg = (s: Settings) => s.connectors.sentry;
const base = (s: Settings) => (cfg(s).baseUrl || 'https://sentry.io').replace(/\/$/, '');
const headers = (s: Settings) => ({ Authorization: `Bearer ${cfg(s).token || process.env.SENTRY_TOKEN || ''}` });

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit?: string;
  permalink: string;
  level?: string;
  count?: string | number;
  userCount?: number;
  firstSeen?: string;
  lastSeen?: string;
  metadata?: { type?: string; value?: string; filename?: string; function?: string };
}

interface Frame { filename?: string; absPath?: string; function?: string; lineNo?: number; colNo?: number; inApp?: boolean; context?: Array<[number, string]> }
export interface SentryEvent { entries?: Array<{ type: string; data: { values?: Array<{ type?: string; value?: string; stacktrace?: { frames?: Frame[] } }> } }> }

/** The last few frames of each exception, app code marked, newest call last (like Sentry shows it). */
export function stackTrace(ev?: SentryEvent, maxFrames = 8): string {
  const ex = ev?.entries?.find((e) => e.type === 'exception')?.data.values ?? [];
  const out: string[] = [];
  for (const v of ex) {
    out.push(`${v.type ?? 'Error'}: ${v.value ?? ''}`.trim());
    const frames = v.stacktrace?.frames ?? [];
    const pick = frames.filter((f) => f.inApp).length ? frames.filter((f) => f.inApp) : frames;
    for (const f of pick.slice(-maxFrames).reverse()) {
      out.push(`  at ${f.function || '<anonymous>'} (${f.filename || f.absPath || '?'}${f.lineNo ? `:${f.lineNo}` : ''}${f.colNo ? `:${f.colNo}` : ''})${f.inApp ? '' : '  [library]'}`);
    }
  }
  return out.join('\n');
}

export function priorityFor(issue: Pick<SentryIssue, 'level' | 'count' | 'userCount'>): Priority {
  const n = Number(issue.count ?? 0);
  if (issue.level === 'fatal' || (issue.userCount ?? 0) >= 100) return 'urgent';
  if (n >= 100 || (issue.userCount ?? 0) >= 10) return 'high';
  if (issue.level === 'warning' || issue.level === 'info') return 'low';
  return 'medium';
}

/** "TypeError: Cannot read properties of undefined (reading 'id')" → "Fix TypeError in checkout: Cannot read…" */
export function ticketTitle(issue: SentryIssue) {
  const where = issue.metadata?.function || issue.culprit?.split(/[ (]/)[0];
  const what = issue.metadata?.type && issue.metadata.value ? `${issue.metadata.type}: ${issue.metadata.value}` : issue.title;
  const t = `Fix ${where ? `${where}: ` : ''}${what}`.replace(/\s+/g, ' ');
  return t.length > 90 ? `${t.slice(0, 87).replace(/\s+\S*$/, '')}…` : t;
}

export function toTicket(issue: SentryIssue, ev?: SentryEvent): ImportedTicket {
  const trace = stackTrace(ev);
  const count = Number(issue.count ?? 0);
  const description = `**Sentry ${issue.shortId}** — ${issue.title}
${issue.culprit ? `In \`${issue.culprit}\`. ` : ''}${count ? `${count.toLocaleString()} event${count === 1 ? '' : 's'}` : ''}${issue.userCount ? `, ${issue.userCount.toLocaleString()} user${issue.userCount === 1 ? '' : 's'}` : ''}${issue.lastSeen ? `, last seen ${issue.lastSeen.slice(0, 16).replace('T', ' ')}` : ''}.
${issue.permalink}
${trace ? `\n\`\`\`\n${trace}\n\`\`\`\n` : ''}
## Acceptance criteria
- [ ] A test reproduces the original error and now passes
- [ ] The code path${issue.culprit ? ` in ${issue.culprit}` : ''} handles this case without throwing
- [ ] Nothing else changes for users who never hit this error`;
  return {
    key: `SEN-${issue.shortId.split('-').pop()}`,
    title: ticketTitle(issue),
    description,
    priority: priorityFor(issue),
    labels: ['bug', 'sentry'],
    externalId: issue.id,
    externalUrl: issue.permalink,
  };
}

/** Sentry signs webhook bodies with HMAC-SHA256 using the integration's client secret. */
export function verifySignature(rawBody: string | Buffer, signature: string | undefined, secret: string) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const sentry: Connector = {
  source: 'sentry',
  label: 'Sentry',
  isEnabled: (s) => !!cfg(s)?.enabled && !!cfg(s).org && !!cfg(s).project && !!(cfg(s).token || process.env.SENTRY_TOKEN),

  async pull(s) {
    const q = encodeURIComponent(cfg(s).query || 'is:unresolved');
    const issues = await http<SentryIssue[]>(`${base(s)}/api/0/projects/${cfg(s).org}/${cfg(s).project}/issues/?query=${q}&limit=25&sort=freq`, { headers: headers(s) });
    const out: ImportedTicket[] = [];
    for (const issue of issues.slice(0, 25)) {
      const ev = await http<SentryEvent>(`${base(s)}/api/0/issues/${issue.id}/events/latest/`, { headers: headers(s) }).catch(() => undefined);
      out.push(toTicket(issue, ev));
    }
    return out;
  },

  async onStage(s, t, stage, message) {
    if (!t.externalId || stage !== 'done') return;
    await http(`${base(s)}/api/0/issues/${t.externalId}/comments/`, { method: 'POST', headers: headers(s), json: { text: `🏭 AI Dev Factory: ${message}` } }).catch(() => undefined);
    await http(`${base(s)}/api/0/issues/${t.externalId}/`, { method: 'PUT', headers: headers(s), json: { status: 'resolved' } });
  },

  async test(s) {
    const p = await http<{ name: string; slug: string }>(`${base(s)}/api/0/projects/${cfg(s).org}/${cfg(s).project}/`, { headers: headers(s) });
    return `Connected to Sentry project ${p.name ?? p.slug}`;
  },
};
