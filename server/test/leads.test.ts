import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { hasPhrase, prefilter, scoreLead } from '../src/leads/classifier.js';
import { DEFAULT_PROFILE, mergeProfile } from '../src/leads/profile.js';
import { LeadStore } from '../src/leads/store.js';
import type { FetchJson } from '../src/leads/sources.js';
import type { RawItem } from '../src/leads/types.js';
import { makeFactory, tmpData, type TestFactory } from './helpers.js';
import path from 'node:path';

const NOW = Date.UTC(2026, 9, 8, 12);
const hoursAgo = (h: number) => Math.floor((NOW - h * 3_600_000) / 1000);

/** A fake web: HN and Reddit answers keyed by host. */
function fakeWeb(): { fetchJson: FetchJson; calls: string[] } {
  const calls: string[] = [];
  const fetchJson: FetchJson = async (url) => {
    calls.push(url);
    if (url.includes('hn.algolia.com')) {
      return {
        hits: [
          {
            objectID: '111', title: 'Ask HN: Our developer disappeared, need someone to take over our app', author: 'founder1',
            story_text: 'We are a funded startup ($40k budget). Our freelance developer disappeared mid-project. Looking for an agency to take over the React Native app.',
            created_at_i: hoursAgo(5), _tags: ['story', 'ask_hn'],
          },
          {
            objectID: '222', title: 'Show HN: I built a drag and drop form builder', author: 'maker', story_text: 'Feedback welcome!',
            created_at_i: hoursAgo(3), _tags: ['story'],
          },
        ],
      };
    }
    if (url.includes('reddit.com')) {
      return {
        data: {
          children: [
            {
              data: {
                id: 'abc', title: 'Need a technical cofounder or dev agency to build our MVP', selftext: 'Non-technical founder, have paying customers on a spreadsheet. Looking for a development agency to build an MVP.',
                author: 'redditor', created_utc: hoursAgo(30), permalink: '/r/startups/comments/abc/x/', subreddit: 'startups',
              },
            },
            {
              data: {
                id: 'def', title: '[For Hire] Full stack developer available', selftext: 'I need a developer job! Looking for developers to work with.',
                author: 'dev', created_utc: hoursAgo(2), permalink: '/r/forhire/comments/def/x/', subreddit: 'forhire',
              },
            },
          ],
        },
      };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchJson, calls };
}

let f: TestFactory | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

function factoryWithWeb() {
  const web = fakeWeb();
  f = makeFactory({ leads: { fetchJson: web.fetchJson, now: () => NOW } });
  // one query per source keeps the fixtures from being fetched several times
  f.leads.updateProfile({
    sources: { hackernews: { enabled: true, queries: ['developer'] }, reddit: { enabled: true, subreddits: ['startups', 'forhire'], queries: ['developer'] } },
    inboxThreshold: 60,
  });
  return { f, web };
}

describe('keyword pre-filter', () => {
  const item = (title: string, text = ''): RawItem => ({ source: 'x', externalId: '1', url: 'u', title, text, postedAt: NOW });

  it('matches whole phrases only', () => {
    expect(hasPhrase('we use rag for search', 'rag')).toBe(true);
    expect(hasPhrase('drag and drop', 'rag')).toBe(false);
    expect(hasPhrase("our dev quit last week", 'dev quit')).toBe(true);
  });

  it('keeps posts that mention a service line and drops excluded ones', () => {
    expect(prefilter(item('Our developer disappeared'), DEFAULT_PROFILE)).toMatchObject({ keep: true, hits: { rescue: ['developer disappeared'] } });
    expect(prefilter(item('Need a developer, equity only'), DEFAULT_PROFILE)).toMatchObject({ keep: false, excludedBy: 'equity only' });
    expect(prefilter(item('What is your favorite editor?'), DEFAULT_PROFILE).keep).toBe(false);
  });

  it('ignores disabled service lines', () => {
    const p = mergeProfile({ lines: DEFAULT_PROFILE.lines.map((l) => ({ ...l, enabled: l.id !== 'rescue' })) });
    expect(prefilter(item('Our developer disappeared'), p).keep).toBe(false);
  });
});

describe('scoring', () => {
  const base = { isLead: true, lineId: 'rescue', confidence: 0.8, summary: '', angle: '' };
  const it0: RawItem = { source: 'x', externalId: '1', url: 'u', title: 't', text: '', postedAt: NOW };

  it('rewards confidence, freshness, budget and the line weight', () => {
    const fresh = scoreLead(base, it0, DEFAULT_PROFILE, NOW);
    const stale = scoreLead(base, { ...it0, postedAt: NOW - 20 * 86_400_000 }, DEFAULT_PROFILE, NOW);
    const broke = scoreLead({ ...base, budgetHint: 'none' }, it0, DEFAULT_PROFILE, NOW);
    const staffing = scoreLead({ ...base, lineId: 'staff' }, it0, DEFAULT_PROFILE, NOW);
    expect(fresh).toBeGreaterThan(stale);
    expect(fresh).toBeGreaterThan(broke);
    expect(fresh).toBeGreaterThan(staffing); // rescue weighs 1.2, staffing 0.9
    expect(fresh).toBeLessThanOrEqual(100);
  });
});

describe('lead store', () => {
  it('keeps leads and the profile in the data folder, separate from db.json', () => {
    const dir = path.dirname(tmpData());
    const s = new LeadStore(dir);
    s.updateProfile({ agencyName: 'Acme' });
    s.addLead({ dedupeKey: 'x:1', source: 'x', url: 'u', title: 't', excerpt: '', summary: '', angle: '', confidence: 1, score: 90, postedAt: NOW });
    s.flush();
    const again = new LeadStore(dir);
    expect(again.profile().agencyName).toBe('Acme');
    expect(again.profile().lines).toHaveLength(4); // defaults fill in
    expect(again.leads()).toHaveLength(1);
    expect(again.hasSeen('x:1')).toBe(true);
  });
});

describe('scout run', () => {
  it('collects, filters, classifies and scores leads', async () => {
    const { f } = factoryWithWeb();
    const run = await f.scouts.run();
    expect(run).toMatchObject({ fetched: 4, created: 2, errors: [] });
    const leads = f.leads.leads();
    expect(leads.map((l) => l.dedupeKey).sort()).toEqual(['hackernews:111', 'reddit:abc']);
    const rescue = leads.find((l) => l.dedupeKey === 'hackernews:111')!;
    expect(rescue).toMatchObject({ lineId: 'rescue', status: 'new', budgetHint: 'mid', url: 'https://news.ycombinator.com/item?id=111' });
    expect(rescue.score).toBeGreaterThan(60);
    expect(leads.find((l) => l.dedupeKey === 'reddit:abc')).toMatchObject({ lineId: 'build', where: 'r/startups' });
  });

  it('never looks at the same post twice', async () => {
    const { f } = factoryWithWeb();
    await f.scouts.run();
    const second = await f.scouts.run();
    expect(second.created).toBe(0);
    expect(f.leads.leads()).toHaveLength(2);
  });

  it('keeps going when a source fails', async () => {
    const web = fakeWeb();
    f = makeFactory({
      leads: { now: () => NOW, fetchJson: (url, init) => (url.includes('reddit') ? Promise.reject(new Error('www.reddit.com answered 429')) : web.fetchJson(url, init)) },
    });
    f.leads.updateProfile({ sources: { hackernews: { enabled: true, queries: ['developer'] }, reddit: { enabled: true, subreddits: ['startups'], queries: ['developer'] } } });
    const run = await f.scouts.run();
    expect(run.errors).toEqual(['Reddit: www.reddit.com answered 429']);
    expect(run.created).toBe(1);
  });

  it('sends hot leads to the inbox, and the answer updates the lead', async () => {
    const { f } = factoryWithWeb();
    await f.scouts.run();
    const hot = f.leads.leads().filter((l) => l.score >= 60);
    expect(hot.length).toBeGreaterThan(0);
    const item = f.store.attention().find((a) => a.key === `lead:${hot[0].id}` && a.status === 'open')!;
    expect(item).toMatchObject({ kind: 'decision', options: [{ id: 'pursue' }, { id: 'pass' }] });
    await request(f.app).post(`/api/attention/${item.id}/resolve`).send({ option: 'pursue' }).expect(200);
    expect(f.leads.lead(hot[0].id)?.status).toBe('reviewing');
  });
});

describe('leads API', () => {
  it('lists leads with the profile and scout status', async () => {
    const { f } = factoryWithWeb();
    await f.scouts.run();
    const r = (await request(f.app).get('/api/leads').expect(200)).body;
    expect(r.items).toHaveLength(2);
    expect(r.profile.lines.map((l: { id: string }) => l.id)).toEqual(['rescue', 'build', 'staff', 'ai']);
    expect(r.scouts).toMatchObject({ running: false, lastRun: { created: 2 } });
    const state = (await request(f.app).get('/api/state').expect(200)).body;
    expect(state.leads.items).toHaveLength(2);
  });

  it('moves a lead through statuses, takes notes, and validates input', async () => {
    const { f } = factoryWithWeb();
    await f.scouts.run();
    const api = request(f.app);
    const id = f.leads.leads()[0].id;
    await api.patch(`/api/leads/${id}`).send({ status: 'contacted', company: ' Acme ' }).expect(200);
    expect(f.leads.lead(id)).toMatchObject({ status: 'contacted', company: 'Acme' });
    // contacting it closes its inbox item
    expect(f.store.openAttention(`lead:${id}`)).toBeUndefined();
    await api.post(`/api/leads/${id}/notes`).send({ text: 'Emailed the founder' }).expect(200);
    expect(f.leads.lead(id)?.notes[0].text).toBe('Emailed the founder');
    await api.patch(`/api/leads/${id}`).send({ status: 'bogus' }).expect(400);
    await api.post(`/api/leads/${id}/notes`).send({ text: ' ' }).expect(400);
    await api.patch('/api/leads/missing').send({ status: 'passed' }).expect(404);
    await api.put('/api/leads/profile').send({ inboxThreshold: 400 }).expect(400);
  });

  it('turns a won lead into a kickoff ticket, once', async () => {
    const { f } = factoryWithWeb();
    await f.scouts.run();
    const api = request(f.app);
    const lead = f.leads.leads().find((l) => l.dedupeKey === 'hackernews:111')!;
    await api.post(`/api/leads/${lead.id}/notes`).send({ text: 'Budget confirmed on call' });
    const won = (await api.post(`/api/leads/${lead.id}/win`).send({}).expect(200)).body;
    expect(won.status).toBe('won');
    const t = f.store.ticket(won.ticketId)!;
    expect(t).toMatchObject({ stage: 'backlog', priority: 'high', labels: ['lead', 'rescue'], externalUrl: lead.url });
    expect(t.description).toContain('Budget confirmed on call');
    await api.post(`/api/leads/${lead.id}/win`).send({}).expect(200);
    expect(f.store.tickets()).toHaveLength(1);
  });

  it('saves the profile', async () => {
    const { f } = factoryWithWeb();
    const r = (await request(f.app).put('/api/leads/profile').send({ agencyName: 'Acme Dev', inboxThreshold: 80 }).expect(200)).body;
    expect(r).toMatchObject({ agencyName: 'Acme Dev', inboxThreshold: 80 });
    expect(f.leads.profile().agencyName).toBe('Acme Dev');
  });
});
