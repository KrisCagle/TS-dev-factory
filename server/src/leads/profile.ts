import type { LeadProfile } from './types.js';

/**
 * A generic agency profile so the scouts work out of the box.
 * Your real one (name, pitch, weights) is saved to the data folder and edited in the Leads view.
 */
export const DEFAULT_PROFILE: LeadProfile = {
  agencyName: 'Your agency',
  about: 'A custom software agency that builds, rescues and maintains web and mobile apps for startups and established businesses.',
  lines: [
    {
      id: 'rescue',
      name: 'Rescue projects',
      enabled: true,
      pitch: 'Take over a stalled, broken or abandoned app, stabilize it and keep it running.',
      keywords: [
        'developer disappeared', 'developer left', 'dev quit', 'freelancer ghosted', 'ghosted me', 'take over', 'took over',
        'inherited codebase', 'legacy app', 'app is broken', 'keeps crashing', 'abandoned', 'no one maintains',
        'need someone to maintain', 'maintenance', 'outgrew bubble', 'outgrown bubble', 'migrate off bubble', 'no-code limits',
        'rescue', 'fix my app', 'spaghetti code', 'technical debt',
      ],
      weight: 1.2,
    },
    {
      id: 'build',
      name: 'Product development',
      enabled: true,
      pitch: 'Design and build an MVP or new product for a founder without a technical team.',
      keywords: [
        'technical cofounder', 'technical co-founder', 'non-technical founder', 'build my app', 'build an mvp', 'build our mvp',
        'need a developer', 'need developers', 'looking for a developer', 'looking for developers', 'dev agency', 'development agency',
        'software agency', 'app developer', 'hire an agency', 'outsource development', 'quote for an app', 'build a platform',
      ],
      weight: 1.0,
    },
    {
      id: 'staff',
      name: 'Team enhancement',
      enabled: true,
      pitch: 'Embed senior developers with an existing team that needs capacity or expertise.',
      keywords: [
        'contract developer', 'contractor', 'need extra hands', 'staff augmentation', 'fractional cto', 'senior developer contract',
        'short-term help', 'overflow work', 'help our team', 'can\'t hire fast enough', 'backlog is growing',
      ],
      weight: 0.9,
    },
    {
      id: 'ai',
      name: 'AI development',
      enabled: true,
      pitch: 'Turn an AI prototype or vibe-coded app into secure, production-ready software.',
      keywords: [
        'vibe coded', 'vibe-coded', 'built with cursor', 'built with lovable', 'built with bolt', 'ai prototype', 'llm app',
        'production ready', 'production-ready', 'rag', 'ai integration', 'add ai to', 'chatgpt wrapper', 'ai agent for',
      ],
      weight: 1.0,
    },
  ],
  excludeKeywords: ['unpaid', 'equity only', 'equity-only', 'rev share only', 'for exposure', 'homework', 'internship', '[for hire]'],
  sources: {
    hackernews: {
      enabled: true,
      queries: ['need a developer', 'technical cofounder', 'development agency', 'take over our app', 'outgrew bubble', 'vibe coded production'],
    },
    reddit: {
      enabled: true,
      subreddits: ['startups', 'SaaS', 'Entrepreneur', 'smallbusiness', 'forhire', 'nocode', 'Bubbleio', 'cofounder'],
      queries: ['developer', 'agency', 'mvp', 'take over app', 'technical cofounder'],
    },
    hnHiring: {
      enabled: true,
      phrases: ['contract', 'contractor', 'freelance', 'part-time', 'part time', 'fractional', 'agency', 'founding engineer', 'first engineer', 'first hire', 'solo founder', 'non-technical founder'],
    },
    remotive: { enabled: true },
    remoteok: { enabled: true },
    samgov: {
      enabled: false,
      apiKey: '',
      // 541511 custom computer programming, 541512 computer systems design
      naics: ['541511', '541512'],
      // o solicitation, k combined synopsis/solicitation, r sources sought, p presolicitation
      noticeTypes: ['o', 'k', 'r', 'p'],
    },
  },
  schedule: { enabled: false, everyHours: 6 },
  inboxThreshold: 75,
  maxAgeDays: 21,
  model: 'haiku',
};

/** Fill in anything a saved profile is missing (new fields survive upgrades). */
export function mergeProfile(saved?: Partial<LeadProfile>): LeadProfile {
  const d = structuredClone(DEFAULT_PROFILE);
  if (!saved) return d;
  return {
    ...d,
    ...saved,
    lines: saved.lines?.length ? saved.lines.map((l) => ({ ...d.lines.find((x) => x.id === l.id), ...l } as LeadProfile['lines'][number])) : d.lines,
    sources: {
      hackernews: { ...d.sources.hackernews, ...(saved.sources?.hackernews ?? {}) },
      reddit: { ...d.sources.reddit, ...(saved.sources?.reddit ?? {}) },
      hnHiring: { ...d.sources.hnHiring, ...(saved.sources?.hnHiring ?? {}) },
      remotive: { ...d.sources.remotive, ...(saved.sources?.remotive ?? {}) },
      remoteok: { ...d.sources.remoteok, ...(saved.sources?.remoteok ?? {}) },
      samgov: { ...d.sources.samgov, ...(saved.sources?.samgov ?? {}) },
    },
    schedule: { ...d.schedule, ...(saved.schedule ?? {}) },
  };
}

export const MASK = '••••••••';

/** The profile for the browser: the SAM.gov key never leaves the server. */
export function publicProfile(p: LeadProfile): LeadProfile {
  const out = structuredClone(p);
  if (out.sources.samgov.apiKey) out.sources.samgov.apiKey = MASK;
  return out;
}
