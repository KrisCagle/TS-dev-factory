// Lead scouts: find companies that might pay an agency to build or maintain their software.
// The web app keeps a mirror of these in web/src/types.ts.

export type LeadStatus = 'new' | 'reviewing' | 'contacted' | 'won' | 'passed';
export const LEAD_STATUSES: LeadStatus[] = ['new', 'reviewing', 'contacted', 'won', 'passed'];

/** One way the agency makes money, and the signals that someone needs it. */
export interface ServiceLine {
  id: string;               // e.g. "rescue"
  name: string;             // e.g. "Rescue Projects"
  enabled: boolean;
  pitch: string;            // one line: what you do for these buyers (feeds the classifier and outreach angle)
  keywords: string[];       // phrases that suggest this need ("developer disappeared", "outgrew bubble")
  weight: number;           // 0.5–1.5: how much you want this kind of work
}

/** Who you are and what you want. Lives in the data folder, never in the repo. */
export interface LeadProfile {
  agencyName: string;
  about: string;            // a sentence or two the classifier uses for fit
  lines: ServiceLine[];
  excludeKeywords: string[]; // drop items that mention these ("unpaid", "equity only", "rev share")
  sources: {
    hackernews: { enabled: boolean; queries: string[] };
    reddit: { enabled: boolean; subreddits: string[]; queries: string[] };
  };
  schedule: { enabled: boolean; everyHours: number };
  inboxThreshold: number;   // leads scoring at or above this go to the Needs you inbox
  maxAgeDays: number;       // ignore posts older than this
  model: string;            // classifier model in live mode
}

/** What a source hands back before classification. */
export interface RawItem {
  source: string;           // "hackernews" | "reddit" | …
  externalId: string;       // stable id within the source, for dedupe
  url: string;
  title: string;
  text: string;
  author?: string;
  postedAt: number;
  where?: string;           // e.g. "r/startups" or "Ask HN"
}

export interface Classification {
  isLead: boolean;
  lineId?: string;
  confidence: number;       // 0–1
  company?: string;
  summary: string;          // what they need, in one sentence
  angle: string;            // suggested opening line for outreach
  budgetHint?: 'none' | 'low' | 'mid' | 'high';
}

export interface LeadNote {
  id: string;
  text: string;
  ts: number;
}

export interface Lead {
  id: string;
  dedupeKey: string;        // source:externalId
  source: string;
  where?: string;
  url: string;
  title: string;
  excerpt: string;
  author?: string;
  company?: string;
  lineId?: string;
  summary: string;
  angle: string;
  confidence: number;
  budgetHint?: Classification['budgetHint'];
  score: number;            // 0–100
  status: LeadStatus;
  notes: LeadNote[];
  ticketId?: string;        // set when won → a ticket was created
  postedAt: number;
  foundAt: number;
  updatedAt: number;
}

export interface ScoutRun {
  id: string;
  startedAt: number;
  finishedAt?: number;
  fetched: number;
  candidates: number;       // passed the keyword pre-filter
  created: number;
  errors: string[];
}

export interface LeadsDB {
  leads: Lead[];
  runs: ScoutRun[];
  /** Everything we've already looked at, so a rejected post isn't classified twice. */
  seen: Record<string, number>;
}
