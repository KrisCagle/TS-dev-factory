import { useEffect, useRef, useState } from 'react';
import { api, type CatchUp } from '../api';
import { ago, duration, money } from '../meta';
import { useFactory } from '../state';
import { useUI } from '../ui';
import type { Ticket } from '../types';

/** Take a ticket over in VS Code, then hand it back for the Tester and Reviewer. */
export function HandOff({ t }: { t: Ticket }) {
  const ui = useUI();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      ui.toast(msg);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  if (t.stage === 'manual') {
    return (
      <div className="handoff">
        <div className="row wrap">
          <strong>🧑‍💻 You have this one</strong>
          <span className="small muted">since {ago(t.manual?.since ?? Date.now())} ago — the agents won’t touch its branch.</span>
          <span className="grow" />
          {t.worktree && <button className="btn sm" disabled={busy} onClick={() => act(() => api.openEditor(t.id), 'Opened in VS Code')}>Open in VS Code ↗</button>}
        </div>
        <div className="row">
          <input className="input" placeholder="What did you change? (optional, helps the Tester and Reviewer)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn primary" disabled={busy} onClick={() => act(() => api.handback(t.id, note), 'Handed back — the Tester checks your changes next')}>↩ Hand back</button>
        </div>
      </div>
    );
  }
  if (t.stage === 'done' || t.stage === 'backlog') return null;
  return (
    <button className="btn" disabled={busy} title="Pause the agents on this ticket and open its branch copy in VS Code" onClick={() => act(() => api.takeover(t.id, true), t.worktree ? 'Taken over — opened in VS Code' : 'Taken over')}>
      🧑‍💻 Take over
    </button>
  );
}

/** "Waits on": pick tickets that must ship first. */
export function Dependencies({ t }: { t: Ticket }) {
  const { allTickets } = useFactory();
  const ui = useUI();
  const [adding, setAdding] = useState(false);
  const deps = (t.dependsOn ?? []).map((id) => allTickets.find((x) => x.id === id)).filter((x): x is Ticket => !!x);
  const candidates = allTickets.filter((x) => x.id !== t.id && x.projectId === t.projectId && x.stage !== 'done' && !(t.dependsOn ?? []).includes(x.id));
  const blocks = allTickets.filter((x) => x.dependsOn?.includes(t.id));
  const save = (dependsOn: string[]) => api.updateTicket(t.id, { dependsOn }).catch((e) => ui.toast(`⚠ ${(e as Error).message}`));
  return (
    <div className="field">Waits on
      <div className="row wrap">
        {deps.map((d) => (
          <span key={d.id} className={`chip dep ${d.stage === 'done' ? 'ok' : ''}`}>
            <button className="linkish mono" onClick={() => ui.openTicket(d.id)}>{d.key}</button> {d.title.slice(0, 32)}{d.stage === 'done' ? ' ✓' : ''}
            <button className="linkish" title="Remove" onClick={() => save((t.dependsOn ?? []).filter((x) => x !== d.id))}>✕</button>
          </span>
        ))}
        {adding ? (
          <select className="select" style={{ width: 'auto' }} autoFocus defaultValue="" onBlur={() => setAdding(false)} onChange={(e) => { if (e.target.value) void save([...(t.dependsOn ?? []), e.target.value]); setAdding(false); }}>
            <option value="" disabled>Pick a ticket…</option>
            {candidates.map((c) => <option key={c.id} value={c.id}>{c.key} — {c.title.slice(0, 50)}</option>)}
          </select>
        ) : (
          <button className="btn ghost sm" onClick={() => setAdding(true)} disabled={!candidates.length}>＋ Add</button>
        )}
        {!deps.length && !adding && <span className="small muted">Nothing — it can start any time.</span>}
      </div>
      {blocks.length > 0 && <div className="small muted">Blocks: {blocks.map((b) => b.key).join(', ')}</div>}
    </div>
  );
}

export function WaitingBanner({ t }: { t: Ticket }) {
  if (!t.waitingOn || t.stage !== 'ready') return null;
  const w = t.waitingOn;
  return (
    <div className="banner" style={{ margin: 0 }}>
      {w.reason === 'dependency'
        ? <>⛓ Waiting for {w.keys.join(', ')} to ship first.</>
        : <>⏸ Waiting: {w.keys.join(', ')} {w.keys.length === 1 ? 'is' : 'are'} changing {w.files?.join(', ')}. It starts when {w.keys.length === 1 ? 'that finishes' : 'they finish'}, so two agents never edit the same files.</>}
    </div>
  );
}

/** The Planner's forecast, and how it compared once the ticket finished. */
export function Forecast({ t }: { t: Ticket }) {
  const e = t.plan?.estimate;
  if (!e) return null;
  const cost = e.adjustedCostUsd ?? e.costUsd;
  const mins = e.adjustedMinutes ?? e.minutes;
  const actualMins = t.finishedAt && t.startedAt ? (t.finishedAt - t.startedAt) / 60_000 : undefined;
  return (
    <div className="forecast small">
      <span className="chip">📏 {e.size}</span> Forecast <strong>{money(cost)}</strong> · <strong>{Math.round(mins)} min</strong>
      {e.adjustedCostUsd !== undefined && <span className="muted" title={`The Planner said ${money(e.costUsd)} / ${e.minutes} min; adjusted for how past forecasts on this project turned out.`}> (adjusted)</span>}
      {t.stage === 'done' && (
        <> → actual <strong style={{ color: t.costUsd > cost * 1.25 ? 'var(--warn)' : 'var(--ok)' }}>{money(t.costUsd)}</strong>{actualMins !== undefined && <> · {duration(actualMins * 60_000)}</>}</>
      )}
      {t.stage !== 'done' && t.costUsd > 0 && <span className="muted"> · {money(t.costUsd)} so far</span>}
    </div>
  );
}

const SUGGESTED = ['Why did you change these files?', 'What’s left?', 'Do the tests pass?', 'Why was it sent back?', 'What did it cost?'];

/** Chat with a ticket: answers come from its plan, log, tests, review and diff. */
export function AskTicket({ t }: { t: Ticket }) {
  const ui = useUI();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const chat = t.chat ?? [];
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [chat.length, busy]);
  const ask = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true);
    setQ('');
    try {
      await api.ask(t.id, question);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
      setQ(question);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ask">
      <div className="asklog">
        {!chat.length && <div className="small muted">Ask anything about {t.key}. Answers come from its plan, agent log, tests, review and diff{''}.</div>}
        {chat.map((m, i) => (
          <div key={i} className="qa">
            <div className="q">{m.q}</div>
            <div className="a">{m.a}</div>
          </div>
        ))}
        {busy && <div className="qa"><div className="a muted">Thinking…</div></div>}
        <div ref={end} />
      </div>
      <div className="row wrap">{SUGGESTED.map((s) => <button key={s} className="btn ghost sm" disabled={busy} onClick={() => ask(s)}>{s}</button>)}</div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void ask(q); }}>
        <input className="input" placeholder={`Ask about ${t.key}…`} value={q} onChange={(e) => setQ(e.target.value)} disabled={busy} />
        <button className="btn primary" disabled={busy || !q.trim()}>Ask</button>
      </form>
    </div>
  );
}

const SEEN_KEY = 'factory.lastSeen';
const AWAY_MS = 20 * 60_000;

const readSeen = () => {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
};
const writeSeen = (ts = Date.now()) => {
  try {
    localStorage.setItem(SEEN_KEY, String(ts));
  } catch {
    /* private mode */
  }
};

/** "While you were away": shown when you come back after 20+ minutes, or from the command palette. */
export function WhileAway() {
  const { project, ready } = useFactory();
  const ui = useUI();
  const [c, setC] = useState<CatchUp | null>(null);

  useEffect(() => {
    if (!ready) return;
    const check = (since: number) => {
      if (!since || Date.now() - since < AWAY_MS) return;
      api.catchup(since, project?.id).then((r) => (r.quiet ? undefined : setC(r))).catch(() => undefined);
    };
    check(readSeen());
    writeSeen();
    const tickSeen = window.setInterval(() => document.visibilityState === 'visible' && writeSeen(), 60_000);
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        writeSeen(hiddenAt);
      } else {
        check(hiddenAt || readSeen());
        writeSeen();
      }
    };
    const onAsk = (e: Event) => api.catchup((e as CustomEvent<number>).detail, project?.id).then(setC).catch(() => undefined);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('factory:catchup', onAsk);
    return () => {
      window.clearInterval(tickSeen);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('factory:catchup', onAsk);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, project?.id]);

  if (!c) return null;
  const open = (id?: string) => {
    if (id) ui.openTicket(id);
    setC(null);
  };
  return (
    <>
      <div className="scrim" onClick={() => setC(null)} />
      <div className="modal card away">
        <div className="row">
          <h3 style={{ margin: 0 }}>👋 While you were away <span className="muted small">({duration(c.awayMs)})</span></h3>
          <span className="grow" />
          <button className="btn ghost sm" onClick={() => setC(null)}>✕</button>
        </div>
        <div className="headline">{c.headline}</div>
        {c.needsYou.length > 0 && (
          <section>
            <strong>✋ Waiting on you</strong>
            <ul>{c.needsYou.map((n) => <li key={n.id}><button className="linkish" onClick={() => open(n.ticketId)}>{n.title}</button>{n.isNew && <span className="chip">new</span>}</li>)}</ul>
          </section>
        )}
        {c.problems.length > 0 && (
          <section>
            <strong>⚠️ Needs a look</strong>
            <ul>{c.problems.map((p) => <li key={p.id}><button className="linkish mono" onClick={() => open(p.id)}>{p.key}</button> {p.title} — <span className="muted">{p.what}</span></li>)}</ul>
          </section>
        )}
        {c.shipped.length > 0 && (
          <section>
            <strong>🚀 Shipped</strong>
            <ul>{c.shipped.map((p) => <li key={p.id}><button className="linkish mono" onClick={() => open(p.id)}>{p.key}</button> {p.title}</li>)}</ul>
          </section>
        )}
        {c.started.length > 0 && (
          <section>
            <strong>⚙️ Started</strong>
            <ul>{c.started.map((p) => <li key={p.id}><button className="linkish mono" onClick={() => open(p.id)}>{p.key}</button> {p.title} <span className="muted small">— now {p.stage.replace('_', ' ')}</span></li>)}</ul>
          </section>
        )}
        <div className="row">
          <span className="small muted">{c.spendUsd ? `Agents spent ${money(c.spendUsd)}.` : ''}</span>
          <span className="grow" />
          {c.needsYou.length > 0 && <button className="btn primary" onClick={() => { setC(null); ui.go('inbox'); }}>Go to Needs you</button>}
          <button className="btn" onClick={() => setC(null)}>Got it</button>
        </div>
      </div>
    </>
  );
}

/** Ask for a catch-up on demand (command palette). */
export function requestCatchUp(sinceMs = Date.now() - 4 * 3_600_000) {
  window.dispatchEvent(new CustomEvent('factory:catchup', { detail: sinceMs }));
}
