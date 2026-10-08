import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Toggle } from '../components/Bits';
import { ago } from '../meta';
import { useFactory } from '../state';
import { useUI } from '../ui';
import type { Lead, LeadProfile, LeadStatus, ServiceLine } from '../types';

const STATUS_META: Record<LeadStatus, { label: string; icon: string }> = {
  new: { label: 'New', icon: '✨' },
  reviewing: { label: 'Reviewing', icon: '👀' },
  contacted: { label: 'Contacted', icon: '✉️' },
  won: { label: 'Won', icon: '🏆' },
  passed: { label: 'Passed', icon: '🚫' },
};
type Filter = LeadStatus | 'open' | 'all';
const OPEN: LeadStatus[] = ['new', 'reviewing', 'contacted'];

/** The sales desk: scouts find companies that might pay you to build or maintain their software. */
export function Leads() {
  const f = useFactory();
  const ui = useUI();
  const [filter, setFilter] = useState<Filter>('open');
  const [line, setLine] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const profile = f.leadProfile;
  const scouts = f.scouts;

  const shown = useMemo(() => f.leads
    .filter((l) => (filter === 'all' ? true : filter === 'open' ? OPEN.includes(l.status) : l.status === filter))
    .filter((l) => line === 'all' || l.lineId === line)
    .sort((a, b) => b.score - a.score || b.postedAt - a.postedAt), [f.leads, filter, line]);
  const count = (s: Filter) => f.leads.filter((l) => (s === 'all' ? true : s === 'open' ? OPEN.includes(l.status) : l.status === s)).length;
  const current = f.leads.find((l) => l.id === selected) ?? shown[0];

  const run = async () => {
    try {
      await api.runScouts();
      ui.toast('🎯 Scouts are out looking');
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };

  if (!profile) return null;
  if (editing) return <ProfileEditor profile={profile} onClose={() => setEditing(false)} />;

  const last = scouts?.lastRun;
  return (
    <div className="leads">
      <div className="row wrap" style={{ marginBottom: 14 }}>
        <div className="seg">
          {(['open', 'new', 'reviewing', 'contacted', 'won', 'passed', 'all'] as Filter[]).map((s) => (
            <button key={s} className={filter === s ? 'on' : ''} onClick={() => setFilter(s)}>
              {s === 'open' ? 'Open' : s === 'all' ? 'All' : STATUS_META[s].label} {count(s) > 0 && `(${count(s)})`}
            </button>
          ))}
        </div>
        <select className="select" style={{ width: 'auto' }} value={line} onChange={(e) => setLine(e.target.value)} aria-label="Service line">
          <option value="all">All service lines</option>
          {profile.lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <span className="grow" />
        <span className="small muted">
          {scouts?.running ? 'Scouting…' : last ? `Last run ${ago(last.startedAt)} ago · ${last.created} new from ${last.fetched} posts${last.skipped?.length ? ` · ${last.skipped.join(', ')} not due yet` : ''}` : 'Never run'}
          {scouts?.nextRunAt && !scouts.running ? ` · next in ${scouts.nextRunAt > Date.now() ? until(scouts.nextRunAt) : 'a minute'}` : ''}
        </span>
        <button className="btn" onClick={() => setEditing(true)}>⚙ Lead profile</button>
        <button className="btn primary" onClick={run} disabled={scouts?.running}>{scouts?.running ? '⏳ Scouting…' : '🎯 Run scouts now'}</button>
      </div>

      {last?.errors.length ? <div className="banner">⚠ {last.errors.join(' · ')}</div> : null}
      {profile.agencyName === 'Your agency' && (
        <div className="banner">Scouts are using the generic agency profile. Add your agency, pitch and service lines in <a href="#" onClick={(e) => { e.preventDefault(); setEditing(true); }}>Lead profile</a> so they score leads for you.</div>
      )}

      {shown.length === 0 ? (
        <div className="empty card" style={{ padding: 32 }}>
          <div style={{ fontSize: 28 }}>🎯</div>
          <strong>{f.leads.length ? 'No leads in this filter.' : 'No leads yet.'}</strong>
          <div className="small">Scouts read public posts on {scouts?.sources.filter((s) => s.enabled).map((s) => s.label).join(' and ') || 'no sources (turn one on in Lead profile)'} for companies that need software built, rescued or maintained.</div>
          {!f.leads.length && <button className="btn primary" style={{ marginTop: 12 }} onClick={run} disabled={scouts?.running}>Run scouts now</button>}
        </div>
      ) : (
        <div className="leads-split">
          <div className="lead-list">
            {shown.map((l) => (
              <button key={l.id} className={`lead-row ${current?.id === l.id ? 'on' : ''}`} onClick={() => setSelected(l.id)}>
                <Score value={l.score} />
                <span className="lead-row-main">
                  <span className="lead-row-title">{l.company ? <strong>{l.company} · </strong> : null}{l.title}</span>
                  <span className="small muted">{lineName(profile, l.lineId)} · {l.where ?? l.source} · {ago(l.postedAt)} ago</span>
                </span>
                {l.status !== 'new' && <span className="chip">{STATUS_META[l.status].icon} {STATUS_META[l.status].label}</span>}
              </button>
            ))}
          </div>
          {current && <LeadDetail lead={current} profile={profile} />}
        </div>
      )}
    </div>
  );
}

function Score({ value }: { value: number }) {
  const tone = value >= 75 ? 'hot' : value >= 50 ? 'warm' : 'cool';
  return <span className={`lead-score ${tone}`} title="Lead score (0–100)">{value}</span>;
}

const until = (ts: number) => {
  const m = Math.ceil((ts - Date.now()) / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
};
const lineName = (p: LeadProfile, id?: string) => p.lines.find((l) => l.id === id)?.name ?? 'Unsorted';

function LeadDetail({ lead, profile }: { lead: Lead; profile: LeadProfile }) {
  const f = useFactory();
  const ui = useUI();
  const [note, setNote] = useState('');
  const [company, setCompany] = useState(lead.company ?? '');
  const [projectId, setProjectId] = useState(f.targetProjectId);
  useEffect(() => setCompany(lead.company ?? ''), [lead.id, lead.company]);
  const ticket = f.allTickets.find((t) => t.id === lead.ticketId);

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      ui.toast(msg);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lead.angle);
      ui.toast('Copied the opening line');
    } catch {
      ui.toast('⚠ Couldn’t reach the clipboard');
    }
  };

  return (
    <article className="card lead-detail">
      <header className="row" style={{ alignItems: 'flex-start' }}>
        <Score value={lead.score} />
        <div className="grow">
          <h3><a href={lead.url} target="_blank" rel="noreferrer noopener">{lead.title} ↗</a></h3>
          <div className="small muted">
            {lineName(profile, lead.lineId)} · {lead.where ?? lead.source}{lead.author ? ` · by ${lead.author}` : ''} · posted {ago(lead.postedAt)} ago · confidence {Math.round(lead.confidence * 100)}%
            {lead.budgetHint ? ` · budget: ${lead.budgetHint}` : ''}
          </div>
        </div>
        <span className="chip">{STATUS_META[lead.status].icon} {STATUS_META[lead.status].label}</span>
      </header>

      <label className="lead-field">
        <span className="small muted">Company</span>
        <input className="input" value={company} placeholder="Unknown — add it when you find out" onChange={(e) => setCompany(e.target.value)}
          onBlur={() => company !== (lead.company ?? '') && act(() => api.updateLead(lead.id, { company }), 'Saved')} />
      </label>

      <section>
        <h4>What they need</h4>
        <p>{lead.summary}</p>
      </section>

      {lead.angle && (
        <section>
          <h4>Opening line <button className="btn ghost sm" onClick={copy}>⧉ Copy</button></h4>
          <p className="lead-angle">{lead.angle}</p>
        </section>
      )}

      {lead.excerpt && (
        <section>
          <h4>The post</h4>
          <blockquote className="lead-excerpt">{lead.excerpt}</blockquote>
        </section>
      )}

      <section>
        <h4>Notes</h4>
        {lead.notes.map((n) => <div key={n.id} className="small" style={{ marginBottom: 4 }}><span className="muted">{ago(n.ts)} ago · </span>{n.text}</div>)}
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (note.trim()) act(() => api.leadNote(lead.id, note), 'Note added').then(() => setNote('')); }}>
          <input className="input" value={note} placeholder="Add a note (who you talked to, budget, next step)…" onChange={(e) => setNote(e.target.value)} />
          <button className="btn" disabled={!note.trim()}>Add</button>
        </form>
      </section>

      <footer className="row wrap">
        {lead.status === 'won' ? (
          ticket ? <button className="btn" onClick={() => f.allTickets.some((t) => t.id === ticket.id) && ui.openTicket(ticket.id)}>Open kickoff ticket {ticket.key}</button> : <span className="small muted">Won</span>
        ) : (
          <>
            {lead.status !== 'reviewing' && <button className="btn" onClick={() => act(() => api.updateLead(lead.id, { status: 'reviewing' }), 'Moved to Reviewing')}>👀 Reviewing</button>}
            {lead.status !== 'contacted' && <button className="btn" onClick={() => act(() => api.updateLead(lead.id, { status: 'contacted' }), 'Marked as contacted')}>✉️ Contacted</button>}
            <span className="grow" />
            {lead.status !== 'passed' && <button className="btn ghost" onClick={() => act(() => api.updateLead(lead.id, { status: 'passed' }), 'Passed')}>Pass</button>}
            {f.projects.length > 1 && (
              <select className="select" style={{ width: 'auto' }} value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project for the kickoff ticket">
                {f.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            <button className="btn ok" title="Creates a kickoff ticket in the Backlog" onClick={() => act(() => api.winLead(lead.id, projectId), '🏆 Won — kickoff ticket added to the Backlog')}>🏆 Won</button>
          </>
        )}
      </footer>
    </article>
  );
}

// ---------------------------------------------------------------- profile editor

const list = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

function ProfileEditor({ profile, onClose }: { profile: LeadProfile; onClose: () => void }) {
  const ui = useUI();
  const [p, setP] = useState<LeadProfile>(() => structuredClone(profile));
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<LeadProfile>) => setP((x) => ({ ...x, ...patch }));
  const setSrc = <K extends keyof LeadProfile['sources']>(k: K, patch: Partial<LeadProfile['sources'][K]>) =>
    setP((x) => ({ ...x, sources: { ...x.sources, [k]: { ...x.sources[k], ...patch } } }));
  const setLine = (i: number, patch: Partial<ServiceLine>) => setP((x) => ({ ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));

  const save = async () => {
    setBusy(true);
    try {
      await api.saveLeadProfile(p);
      ui.toast('Lead profile saved');
      onClose();
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lead-profile">
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn ghost" onClick={onClose}>← Leads</button>
        <span className="small muted">Saved in the factory’s data folder, not in the repo.</span>
        <span className="grow" />
        <button className="btn primary" onClick={save} disabled={busy}>Save profile</button>
      </div>

      <div className="card section">
        <h2>Your agency</h2>
        <div className="grid2">
          <label className="lead-field"><span className="small muted">Name</span><input className="input" value={p.agencyName} onChange={(e) => set({ agencyName: e.target.value })} /></label>
          <label className="lead-field"><span className="small muted">Classifier model (live mode)</span><input className="input" value={p.model} onChange={(e) => set({ model: e.target.value })} /></label>
        </div>
        <label className="lead-field"><span className="small muted">About — what you do and who you do it for</span><textarea className="textarea" rows={2} value={p.about} onChange={(e) => set({ about: e.target.value })} /></label>
        <div className="grid2">
          <label className="lead-field"><span className="small muted">Send leads scoring at least this to Needs you</span><input className="input" type="number" min={0} max={100} value={p.inboxThreshold} onChange={(e) => set({ inboxThreshold: Number(e.target.value) })} /></label>
          <label className="lead-field"><span className="small muted">Ignore posts older than (days)</span><input className="input" type="number" min={1} max={90} value={p.maxAgeDays} onChange={(e) => set({ maxAgeDays: Number(e.target.value) })} /></label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <Toggle on={p.schedule.enabled} onChange={(v) => set({ schedule: { ...p.schedule, enabled: v } })} />
          <span>Run scouts every</span>
          <input className="input" type="number" min={1} max={168} style={{ width: 70 }} value={p.schedule.everyHours} onChange={(e) => set({ schedule: { ...p.schedule, everyHours: Number(e.target.value) } })} />
          <span>hours while the factory is running</span>
        </div>
      </div>

      <div className="card section" style={{ marginTop: 12 }}>
        <h2>Service lines <span className="small muted">— what you sell, and the phrases that mean someone needs it</span></h2>
        <div className="alist">
          {p.lines.map((l, i) => (
            <div key={i} className="lead-line">
              <div className="row">
                <Toggle on={l.enabled} onChange={(v) => setLine(i, { enabled: v })} />
                <input className="input" value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} aria-label="Service line name" />
                <label className="row small muted" style={{ flex: 'none' }} title="How much you want this kind of work">
                  Weight
                  <input type="range" min={0.5} max={1.5} step={0.1} value={l.weight} onChange={(e) => setLine(i, { weight: Number(e.target.value) })} />
                  <span className="mono">{l.weight.toFixed(1)}</span>
                </label>
                <button className="btn ghost sm danger" onClick={() => setP((x) => ({ ...x, lines: x.lines.filter((_, j) => j !== i) }))} aria-label="Remove service line">✕</button>
              </div>
              <input className="input" value={l.pitch} placeholder="One line: what you do for these buyers" onChange={(e) => setLine(i, { pitch: e.target.value })} />
              <textarea className="textarea mono small" rows={2} value={l.keywords.join(', ')} placeholder="Phrases, comma separated" onChange={(e) => setLine(i, { keywords: list(e.target.value) })} />
            </div>
          ))}
        </div>
        <button className="btn" style={{ marginTop: 10 }} onClick={() => setP((x) => ({ ...x, lines: [...x.lines, { id: `line-${Date.now().toString(36)}`, name: 'New line', enabled: true, pitch: '', keywords: [], weight: 1 }] }))}>＋ Add service line</button>
      </div>

      <div className="card section" style={{ marginTop: 12 }}>
        <h2>Where scouts look</h2>
        <div className="small muted" style={{ marginBottom: 10 }}>Forums, where founders ask for help in public:</div>
        <div className="row"><Toggle on={p.sources.hackernews.enabled} onChange={(v) => set({ sources: { ...p.sources, hackernews: { ...p.sources.hackernews, enabled: v } } })} /><strong>Hacker News</strong><span className="small muted">stories and comments, via the public Algolia API</span></div>
        <label className="lead-field"><span className="small muted">Searches</span><textarea className="textarea mono small" rows={2} value={p.sources.hackernews.queries.join(', ')} onChange={(e) => set({ sources: { ...p.sources, hackernews: { ...p.sources.hackernews, queries: list(e.target.value) } } })} /></label>
        <div className="row" style={{ marginTop: 10 }}><Toggle on={p.sources.reddit.enabled} onChange={(v) => set({ sources: { ...p.sources, reddit: { ...p.sources.reddit, enabled: v } } })} /><strong>Reddit</strong><span className="small muted">public search across these subreddits</span></div>
        <div className="grid2">
          <label className="lead-field"><span className="small muted">Subreddits</span><textarea className="textarea mono small" rows={2} value={p.sources.reddit.subreddits.join(', ')} onChange={(e) => set({ sources: { ...p.sources, reddit: { ...p.sources.reddit, subreddits: list(e.target.value) } } })} /></label>
          <label className="lead-field"><span className="small muted">Searches</span><textarea className="textarea mono small" rows={2} value={p.sources.reddit.queries.join(', ')} onChange={(e) => set({ sources: { ...p.sources, reddit: { ...p.sources.reddit, queries: list(e.target.value) } } })} /></label>
        </div>
        <div className="small muted" style={{ margin: '18px 0 10px' }}>Job boards and contracts, where companies already pay for outside help:</div>
        <div className="row"><Toggle on={p.sources.hnHiring.enabled} onChange={(v) => setSrc('hnHiring', { enabled: v })} /><strong>HN “Who is hiring?”</strong><span className="small muted">the monthly thread; keeps company posts that mention these</span></div>
        <label className="lead-field"><span className="small muted">Keep posts that mention</span><textarea className="textarea mono small" rows={2} value={p.sources.hnHiring.phrases.join(', ')} onChange={(e) => setSrc('hnHiring', { phrases: list(e.target.value) })} /></label>

        <div className="row" style={{ marginTop: 14 }}><Toggle on={p.sources.remotive.enabled} onChange={(v) => setSrc('remotive', { enabled: v })} /><strong>Remotive</strong><span className="small muted">contract and freelance software roles · checked at most every 6 hours, as Remotive asks</span></div>
        <div className="row" style={{ marginTop: 10 }}><Toggle on={p.sources.remoteok.enabled} onChange={(v) => setSrc('remoteok', { enabled: v })} /><strong>RemoteOK</strong><span className="small muted">contract and freelance developer roles · checked at most every 6 hours</span></div>

        <div className="row" style={{ marginTop: 14 }}><Toggle on={p.sources.samgov.enabled} onChange={(v) => setSrc('samgov', { enabled: v })} /><strong>SAM.gov</strong><span className="small muted">federal solicitations for custom software · checked once a day to fit the free API quota</span></div>
        <div className="grid2">
          <label className="lead-field"><span className="small muted">API key (SAM.gov → Account details → Public API key)</span><input className="input mono" type="password" autoComplete="off" value={p.sources.samgov.apiKey} placeholder="Paste your key" onChange={(e) => setSrc('samgov', { apiKey: e.target.value.trim() })} /></label>
          <label className="lead-field"><span className="small muted">NAICS codes</span><input className="input mono" value={p.sources.samgov.naics.join(', ')} onChange={(e) => setSrc('samgov', { naics: list(e.target.value) })} /></label>
        </div>
        {p.sources.samgov.enabled && !p.sources.samgov.apiKey && <div className="small" style={{ color: 'var(--warn)', marginTop: 6 }}>Add an API key, or SAM.gov is skipped.</div>}

        <label className="lead-field" style={{ marginTop: 14 }}><span className="small muted">Skip posts that mention</span><textarea className="textarea mono small" rows={2} value={p.excludeKeywords.join(', ')} onChange={(e) => set({ excludeKeywords: list(e.target.value) })} /></label>
      </div>
    </div>
  );
}
