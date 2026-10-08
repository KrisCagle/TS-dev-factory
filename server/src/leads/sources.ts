import { hasPhrase } from './classifier.js';
import type { LeadProfile, RawItem } from './types.js';

export type FetchJson = (url: string, init?: { headers?: Record<string, string> }) => Promise<unknown>;

/** Where scouts look. Each source turns a profile into raw posts; classification happens later. */
export interface LeadSource {
  id: string;
  label: string;
  /** Some sources ask to be polled rarely (Remotive) or have tight daily quotas (SAM.gov). */
  minIntervalHours?: number;
  isEnabled(p: LeadProfile): boolean;
  fetch(p: LeadProfile, since: number, fetchJson: FetchJson): Promise<RawItem[]>;
}

const UA = 'ai-dev-factory-lead-scout/0.1 (+https://github.com/KrisCagle/ai-dev-factory)';

export const defaultFetchJson: FetchJson = async (url, init) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
};

// ---------------------------------------------------------------- Hacker News (Algolia API, free and public)

interface HnHit {
  objectID: string;
  title?: string | null;
  story_title?: string | null;
  story_text?: string | null;
  comment_text?: string | null;
  author?: string;
  created_at_i: number;
  _tags?: string[];
}

export const hackernews: LeadSource = {
  id: 'hackernews',
  label: 'Hacker News',
  isEnabled: (p) => p.sources.hackernews.enabled && p.sources.hackernews.queries.length > 0,
  async fetch(p, since, fetchJson) {
    const out: RawItem[] = [];
    for (const q of p.sources.hackernews.queries) {
      const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=(story,comment)&numericFilters=created_at_i>${Math.floor(since / 1000)}&hitsPerPage=50`;
      const data = (await fetchJson(url)) as { hits?: HnHit[] };
      for (const h of data.hits ?? []) {
        const isComment = h._tags?.includes('comment');
        const title = h.title || (h.story_title ? `Comment on: ${h.story_title}` : 'Hacker News post');
        out.push({
          source: 'hackernews',
          externalId: h.objectID,
          url: `https://news.ycombinator.com/item?id=${h.objectID}`,
          title,
          text: stripHtml(h.story_text || h.comment_text || ''),
          author: h.author,
          postedAt: h.created_at_i * 1000,
          where: isComment ? 'HN comment' : title.startsWith('Ask HN') ? 'Ask HN' : 'HN story',
        });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------- Reddit (public JSON search)

interface RedditPost {
  id: string;
  title: string;
  selftext?: string;
  author?: string;
  created_utc: number;
  permalink: string;
  subreddit: string;
  link_flair_text?: string | null;
}

export const reddit: LeadSource = {
  id: 'reddit',
  label: 'Reddit',
  isEnabled: (p) => p.sources.reddit.enabled && p.sources.reddit.subreddits.length > 0,
  async fetch(p, since, fetchJson) {
    const subs = p.sources.reddit.subreddits.map((s) => s.replace(/^r\//i, '').trim()).filter(Boolean).join('+');
    const queries = p.sources.reddit.queries.length ? p.sources.reddit.queries : [''];
    const out: RawItem[] = [];
    for (const q of queries) {
      const url = q
        ? `https://www.reddit.com/r/${subs}/search.json?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new&t=month&limit=50`
        : `https://www.reddit.com/r/${subs}/new.json?limit=50`;
      const data = (await fetchJson(url)) as { data?: { children?: Array<{ data: RedditPost }> } };
      for (const { data: r } of data.data?.children ?? []) {
        const postedAt = r.created_utc * 1000;
        if (postedAt < since) continue;
        out.push({
          source: 'reddit',
          externalId: r.id,
          url: `https://www.reddit.com${r.permalink}`,
          title: r.link_flair_text ? `[${r.link_flair_text}] ${r.title}` : r.title,
          text: r.selftext ?? '',
          author: r.author,
          postedAt,
          where: `r/${r.subreddit}`,
        });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------- HN "Who is hiring?" (monthly thread)

interface HnItem {
  id: number;
  author?: string;
  text?: string | null;
  title?: string | null;
  created_at_i: number;
  children?: HnItem[];
}

const CONTRACT = /\b(contract(or|ors)?|freelance(r|rs)?|part[- ]time|fractional|agency|agencies)\b/i;
const TINY_TEAM = /\b(founding engineer|first (engineer|developer|hire|technical hire)|solo founder|non-technical founder|technical co-?founder)\b/i;

export const hnHiring: LeadSource = {
  id: 'hnHiring',
  label: 'HN Who is hiring',
  minIntervalHours: 12,
  isEnabled: (p) => p.sources.hnHiring.enabled,
  async fetch(p, since, fetchJson) {
    const found = (await fetchJson('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10')) as { hits?: Array<{ objectID: string; title?: string }> };
    const thread = found.hits?.find((h) => /who is hiring/i.test(h.title ?? ''));
    if (!thread) return [];
    const item = (await fetchJson(`https://hn.algolia.com/api/v1/items/${thread.objectID}`)) as HnItem;
    const out: RawItem[] = [];
    for (const c of item.children ?? []) {
      const text = stripHtml(c.text ?? '');
      const postedAt = c.created_at_i * 1000;
      if (!text || postedAt < since) continue;
      const wanted = p.sources.hnHiring.phrases.some((ph) => hasPhrase(text.toLowerCase(), ph));
      if (!wanted) continue;
      const head = text.split('\n')[0];
      const company = head.split('|')[0].trim().slice(0, 80) || undefined;
      out.push({
        source: 'hnHiring',
        externalId: String(c.id),
        url: `https://news.ycombinator.com/item?id=${c.id}`,
        title: head.length > 140 ? `${head.slice(0, 139)}…` : head,
        text,
        author: c.author,
        postedAt,
        where: item.title ?? 'Who is hiring',
        company,
        kind: 'job',
        hint: TINY_TEAM.test(text) ? 'build' : CONTRACT.test(text) ? 'staff' : undefined,
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- Remotive (public API; asks for ≤4 fetches a day and a link back)

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  job_type?: string;
  publication_date: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

export const remotive: LeadSource = {
  id: 'remotive',
  label: 'Remotive',
  minIntervalHours: 6,
  isEnabled: (p) => p.sources.remotive.enabled,
  async fetch(_p, since, fetchJson) {
    const data = (await fetchJson('https://remotive.com/api/remote-jobs?category=software-dev')) as { jobs?: RemotiveJob[] };
    const out: RawItem[] = [];
    for (const j of data.jobs ?? []) {
      const postedAt = Date.parse(j.publication_date);
      const text = stripHtml(j.description ?? '');
      const contract = ['contract', 'freelance', 'part_time'].includes(j.job_type ?? '') || CONTRACT.test(j.title);
      if (!(postedAt >= since) || !(contract || TINY_TEAM.test(text))) continue;
      out.push({
        source: 'remotive',
        externalId: String(j.id),
        url: j.url,
        title: `${j.title} at ${j.company_name}`,
        text: [j.job_type && `Type: ${j.job_type.replace('_', ' ')}`, j.salary && `Pay: ${j.salary}`, j.candidate_required_location && `Location: ${j.candidate_required_location}`, text].filter(Boolean).join('\n'),
        postedAt,
        where: 'Remotive',
        company: j.company_name,
        kind: 'job',
        hint: contract ? 'staff' : 'build',
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- RemoteOK (public API; asks for a link back)

interface RemoteOkJob {
  id?: string;
  epoch?: number;
  company?: string;
  position?: string;
  tags?: string[];
  description?: string;
  url?: string;
  location?: string;
  salary_min?: number;
  salary_max?: number;
}

const DEV = /\b(developer|engineer|programmer|software|full[- ]?stack|front[- ]?end|back[- ]?end|mobile|ios|android|react|rails|python|node)\b/i;

export const remoteok: LeadSource = {
  id: 'remoteok',
  label: 'RemoteOK',
  minIntervalHours: 6,
  isEnabled: (p) => p.sources.remoteok.enabled,
  async fetch(_p, since, fetchJson) {
    const data = (await fetchJson('https://remoteok.com/api')) as RemoteOkJob[];
    const out: RawItem[] = [];
    for (const j of Array.isArray(data) ? data : []) {
      if (!j.id || !j.position || !j.epoch) continue; // the first entry is the legal notice
      const postedAt = j.epoch * 1000;
      const text = stripHtml(j.description ?? '');
      const tags = (j.tags ?? []).join(' ');
      const contract = CONTRACT.test(`${j.position} ${tags}`);
      if (postedAt < since || !DEV.test(`${j.position} ${tags}`) || !(contract || TINY_TEAM.test(text))) continue;
      out.push({
        source: 'remoteok',
        externalId: String(j.id),
        url: j.url ?? `https://remoteok.com/remote-jobs/${j.id}`,
        title: `${j.position} at ${j.company ?? 'a company'}`,
        text: [tags && `Tags: ${tags}`, j.salary_max ? `Pay: $${j.salary_min ?? '?'}–$${j.salary_max}` : '', j.location && `Location: ${j.location}`, text].filter(Boolean).join('\n'),
        postedAt,
        where: 'RemoteOK',
        company: j.company,
        kind: 'job',
        hint: contract ? 'staff' : 'build',
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- SAM.gov (federal contract opportunities; free API key, small daily quota)

interface SamOpportunity {
  noticeId: string;
  title: string;
  solicitationNumber?: string;
  fullParentPathName?: string;
  postedDate: string;
  type?: string;
  baseType?: string;
  typeOfSetAsideDescription?: string | null;
  responseDeadLine?: string | null;
  naicsCode?: string;
  uiLink?: string;
}

const SAM_TYPES: Record<string, string> = { o: 'Solicitation', k: 'Combined Synopsis/Solicitation', r: 'Sources Sought', p: 'Presolicitation' };
const SUSTAIN = /\b(maint(enance|ain)|sustain(ment)?|moderni[sz](e|ation)|legacy|o&m|operations and maintenance|support services?|enhancements?)\b/i;

const mmddyyyy = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
};

export const samgov: LeadSource = {
  id: 'samgov',
  label: 'SAM.gov',
  minIntervalHours: 24,
  isEnabled: (p) => p.sources.samgov.enabled && !!p.sources.samgov.apiKey && p.sources.samgov.naics.length > 0,
  async fetch(p, since, fetchJson) {
    const s = p.sources.samgov;
    const types = new Set(s.noticeTypes.map((t) => SAM_TYPES[t]).filter(Boolean));
    const out: RawItem[] = [];
    for (const naics of s.naics) {
      const url = `https://api.sam.gov/opportunities/v2/search?api_key=${encodeURIComponent(s.apiKey)}&postedFrom=${mmddyyyy(since)}&postedTo=${mmddyyyy(Date.now())}&ncode=${encodeURIComponent(naics)}&limit=200`;
      let data: { opportunitiesData?: SamOpportunity[] };
      try {
        data = (await fetchJson(url)) as typeof data;
      } catch (err) {
        // never echo the key back in an error message
        throw new Error((err as Error).message.replace(s.apiKey, '•••'));
      }
      for (const o of data.opportunitiesData ?? []) {
        if (types.size && !types.has(o.type ?? '') && !types.has(o.baseType ?? '')) continue;
        const agency = o.fullParentPathName?.split('.')[0]?.trim();
        out.push({
          source: 'samgov',
          externalId: o.noticeId,
          url: `https://sam.gov/opp/${o.noticeId}/view`,
          title: o.title,
          text: [
            `Notice type: ${o.type ?? o.baseType ?? 'unknown'}`,
            o.fullParentPathName && `Agency: ${o.fullParentPathName.replace(/\./g, ' › ')}`,
            o.solicitationNumber && `Solicitation: ${o.solicitationNumber}`,
            o.naicsCode && `NAICS: ${o.naicsCode}`,
            o.typeOfSetAsideDescription && `Set-aside: ${o.typeOfSetAsideDescription}`,
            o.responseDeadLine && `Responses due: ${o.responseDeadLine.slice(0, 10)}`,
          ].filter(Boolean).join('\n'),
          postedAt: Date.parse(o.postedDate),
          where: 'SAM.gov',
          company: agency,
          kind: 'rfp',
          hint: SUSTAIN.test(o.title) ? 'rescue' : 'build',
        });
      }
    }
    return out;
  },
};

export const SOURCES: LeadSource[] = [hackernews, reddit, hnHiring, remotive, remoteok, samgov];

export function stripHtml(html: string) {
  return html
    .replace(/<p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .trim();
}
