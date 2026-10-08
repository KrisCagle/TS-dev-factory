import type { LeadProfile, RawItem } from './types.js';

export type FetchJson = (url: string, init?: { headers?: Record<string, string> }) => Promise<unknown>;

/** Where scouts look. Each source turns a profile into raw posts; classification happens later. */
export interface LeadSource {
  id: string;
  label: string;
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

export const SOURCES: LeadSource[] = [hackernews, reddit];

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
