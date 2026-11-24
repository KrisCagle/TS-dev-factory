import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { DecisionCard } from '../components/Attention';
import { ago, money } from '../meta';
import { useFactory } from '../state';
import { useUI } from '../ui';
import type { ScarifFleet, SessionState, WorkSession } from '../types';

export const SESSION_STATE: Record<SessionState, { label: string; color: string }> = {
  queued: { label: 'Queued', color: 'var(--muted)' },
  running: { label: 'Working', color: 'var(--accent)' },
  waiting: { label: 'Waiting on you', color: 'var(--warn)' },
  idle: { label: 'Idle', color: 'var(--ok)' },
  done: { label: 'Done', color: 'var(--muted)' },
  error: { label: 'Error', color: 'var(--bad)' },
  interrupted: { label: 'Interrupted', color: 'var(--warn)' },
  stopped: { label: 'Stopped', color: 'var(--muted)' },
};

const REPORT_ICON = { result: '✅', review: '🧾', question: '💬', blocked: '⛔' } as const;

/** Claude Code sessions in your repos, plus the Scarif droids working your tickets. */
export function Sessions() {
  const f = useFactory();
  const ui = useUI();
  const [selected, setSelected] = useState<string | null>(ui.focused.session ?? null);
  const [showDone, setShowDone] = useState(false);
  useEffect(() => { if (ui.focused.session) setSelected(ui.focused.session); }, [ui.focused.session]);

  const live = f.sessions.filter((s) => !['done', 'stopped'].includes(s.state));
  const finished = f.sessions.filter((s) => ['done', 'stopped'].includes(s.state));
  const current = f.sessions.find((s) => s.id === selected) ?? live[0];

  return (
    <div className="sessions">
      <div className="slist">
        <NewSession onStarted={(id) => setSelected(id)} />
        {live.map((s) => <SessionRow key={s.id} s={s} active={current?.id === s.id} onClick={() => setSelected(s.id)} />)}
        {!live.length && <div className="small muted" style={{ padding: '4px 2px' }}>No open sessions. Start one above, or say “start a session in … to …” to the assistant.</div>}
        {finished.length > 0 && (
          <>
            <button className="btn ghost sm" onClick={() => setShowDone((v) => !v)}>{showDone ? '▾' : '▸'} Finished ({finished.length})</button>
            {showDone && finished.map((s) => <SessionRow key={s.id} s={s} active={current?.id === s.id} onClick={() => setSelected(s.id)} />)}
          </>
        )}
        <ScarifPanel fleet={f.scarif} />
      </div>
      <div className="sdetail">{current ? <SessionDetail key={current.id} s={current} /> : <EmptyDetail />}</div>
    </div>
  );
}

function EmptyDetail() {
  const { engine } = useFactory();
  return (
    <div className="card empty" style={{ padding: 28, textAlign: 'left' }}>
      <h3 style={{ marginTop: 0 }}>🧵 Sessions</h3>
      <p>A session is Claude Code working in one of your repos on whatever you ask: a fix, an investigation, a refactor. It never waits on you — questions, decisions and finished work land in <strong>Needs you</strong>, and your answers go straight back into the conversation.</p>
      <p className="small muted">
        {engine?.pluginDirs.length
          ? <>Sessions load {engine.pluginDirs.map((d) => <code key={d}>{d.split('/').slice(-2).join('/')}</code>)} so they follow your team’s process skills.</>
          : <>Tip: add your team’s Claude Code process plugin in Settings → Sessions so sessions follow it.</>}
      </p>
    </div>
  );
}

function SessionRow({ s, active, onClick }: { s: WorkSession; active: boolean; onClick: () => void }) {
  const { projects, attention } = useFactory();
  const p = projects.find((x) => x.id === s.projectId);
  const st = SESSION_STATE[s.state];
  const open = attention.filter((a) => a.sessionId === s.id && a.status === 'open').length;
  return (
    <button className={`srow ${active ? 'on' : ''}`} onClick={onClick}>
      <div className="row">
        <span className={`sdot ${s.state === 'running' ? 'pulse' : ''}`} style={{ background: st.color }} title={st.label} />
        <strong className="grow ellipsis">{s.title}</strong>
        {open > 0 && <span className="count" title="Waiting on you">{open}</span>}
      </div>
      <div className="small muted row">
        {p && <span className="chip" style={{ borderColor: p.color }}>{p.name}</span>}
        <span>{st.label}</span>
        <span className="grow" />
        <span>{ago(s.updatedAt)}</span>
      </div>
      {s.report && <div className="small ellipsis">{REPORT_ICON[s.report.kind]} {s.report.text}</div>}
    </button>
  );
}

function NewSession({ onStarted }: { onStarted: (id: string) => void }) {
  const f = useFactory();
  const ui = useUI();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState(f.targetProjectId);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setProjectId(f.targetProjectId), [f.targetProjectId]);
  const start = async () => {
    setBusy(true);
    try {
      const s = await api.startSession({ projectId, prompt });
      setPrompt('');
      setOpen(false);
      onStarted(s.id);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <button className="btn primary" onClick={() => setOpen(true)}>＋ New session</button>;
  return (
    <div className="card" style={{ padding: 12, display: 'grid', gap: 8 }}>
      <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        {f.projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.repoPath ? '' : ' (no repo set)'}</option>)}
      </select>
      <textarea
        className="textarea"
        autoFocus
        placeholder="What should it do? e.g. “Find why the nightly sync drops rows and fix it”, or a skill: “/create-user-stories for …”"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim()) void start(); }}
        style={{ minHeight: 80 }}
      />
      <div className="row">
        <button className="btn primary" disabled={!prompt.trim() || busy} onClick={start}>Start</button>
        <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
        <span className="small muted">⌘↵ to start</span>
      </div>
    </div>
  );
}

function SessionDetail({ s }: { s: WorkSession }) {
  const { projects, attention, settings } = useFactory();
  const ui = useUI();
  const [text, setText] = useState('');
  const [showTools, setShowTools] = useState(true);
  const feed = useRef<HTMLDivElement>(null);
  const p = projects.find((x) => x.id === s.projectId);
  const st = SESSION_STATE[s.state];
  const items = attention.filter((a) => a.sessionId === s.id && a.status === 'open');
  const events = useMemo(() => s.events.filter((e) => showTools || e.kind !== 'tool'), [s.events, showTools]);

  useEffect(() => {
    const el = feed.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  useEffect(() => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, []);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) ui.toast(done);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };
  const send = () => {
    if (!text.trim()) return;
    const t = text;
    setText('');
    void act(() => api.messageSession(s.id, t));
  };

  return (
    <div className="card sdcard">
      <header className="row wrap">
        <span className={`sdot ${s.state === 'running' ? 'pulse' : ''}`} style={{ background: st.color }} />
        <h2 style={{ margin: 0 }} className="grow">{s.title}</h2>
        {p && <span className="chip">{p.name}</span>}
        <span className="chip">{st.label}</span>
        {s.costUsd > 0 && <span className="chip" title="Spend so far">{money(s.costUsd)}</span>}
        {s.state === 'running' || s.state === 'queued' || s.state === 'waiting'
          ? <button className="btn sm danger" onClick={() => act(() => api.stopSession(s.id), 'Stopped')}>■ Stop</button>
          : s.state === 'interrupted' || s.state === 'error' || s.state === 'stopped'
            ? <button className="btn sm primary" onClick={() => act(() => api.resumeSession(s.id), 'Resuming')}>▶ Resume</button>
            : null}
        {s.state === 'idle' && <button className="btn sm" onClick={() => act(() => api.finishSession(s.id), 'Marked done')}>✓ Done</button>}
        <button className="btn sm ghost" title="Delete this session’s history" onClick={() => confirm('Delete this session and its history?') && act(() => api.deleteSession(s.id))}>🗑</button>
      </header>
      {s.state === 'interrupted' && <div className="banner">The factory restarted while this session was working. Resume picks it up where it left off.</div>}
      {s.error && s.state === 'error' && <div className="banner bad">{s.error}</div>}
      {s.report && (
        <div className={`sreport ${s.report.kind}`}>
          <strong>{REPORT_ICON[s.report.kind]} {s.report.kind.toUpperCase()}</strong> {s.report.text}
        </div>
      )}
      {items.length > 0 && <div className="alist" style={{ margin: '8px 0' }}>{items.map((a) => <DecisionCard key={a.id} item={a} showTicket={false} />)}</div>}
      <div className="row small muted" style={{ justifyContent: 'space-between' }}>
        <span>{s.turns} turn{s.turns === 1 ? '' : 's'} · started {ago(s.createdAt)} ago{settings?.mode === 'mock' ? ' · simulated' : ''}</span>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} /> Show tool calls</label>
      </div>
      <div className="sfeed" ref={feed}>
        {events.map((e, i) => (
          <div key={i} className={`sev ${e.kind}`}>
            {e.kind === 'tool' ? <span className="mono">⏺ {e.text}</span> : e.kind === 'you' ? <><span className="who">You</span><div className="pre">{e.text}</div></> : <div className="pre">{e.text}</div>}
          </div>
        ))}
        {s.state === 'running' && <div className="sev status small muted">working…</div>}
        {!events.length && <div className="small muted">Nothing yet.</div>}
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <textarea
          className="textarea grow"
          style={{ minHeight: 44 }}
          placeholder={s.state === 'running' ? 'Add to what it’s doing — picked up right after this turn…' : 'Message this session…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button className="btn primary" disabled={!text.trim()} onClick={send}>Send</button>
      </div>
    </div>
  );
}

function ScarifPanel({ fleet }: { fleet: ScarifFleet | null }) {
  const ui = useUI();
  const { allTickets } = useFactory();
  if (!fleet || fleet.state === 'off') {
    return (
      <div className="card small" style={{ padding: 12 }}>
        <strong>🛰 Scarif droids</strong>
        <div className="muted">Off. Turn it on in Settings → Integrations to send tickets to remote workers and watch them here.</div>
      </div>
    );
  }
  const byKey = (k: string) => allTickets.find((t) => t.remote?.key === k || t.externalId === k);
  return (
    <div className="card small" style={{ padding: 12, display: 'grid', gap: 8 }}>
      <div className="row">
        <strong className="grow">🛰 Scarif droids</strong>
        <button className="btn sm ghost" onClick={() => api.scarif(true).catch((e) => ui.toast(`⚠ ${e.message}`))}>↻</button>
      </div>
      {fleet.state === 'unconfigured' && <div className="muted">Not set up — run <code>scarif setup</code> on this Mac (or add a URL and token in Settings).</div>}
      {fleet.state === 'error' && <div style={{ color: 'var(--bad)' }}>{fleet.error}</div>}
      {fleet.state === 'ready' && !fleet.workers.length && !fleet.queued.length && <div className="muted">No droids are working your jobs.</div>}
      {fleet.workers.map((w) => (
        <div key={w.id} className="droid">
          <div className="row"><span className={`sdot ${w.jobs.length ? 'pulse' : ''}`} style={{ background: w.healthy === false ? 'var(--bad)' : 'var(--ok)' }} /><strong className="grow">{w.name}</strong><span className="muted">{w.status}{w.load !== undefined ? ` · load ${w.load.toFixed(1)}` : ''}</span></div>
          {w.jobs.map((j) => <JobLine key={j.workItemId} j={j} onOpen={() => { const t = byKey(j.key); if (t) ui.openTicket(t.id); }} />)}
        </div>
      ))}
      {fleet.queued.length > 0 && (
        <div className="droid"><strong>Queued</strong>{fleet.queued.map((j) => <JobLine key={j.workItemId} j={j} onOpen={() => { const t = byKey(j.key); if (t) ui.openTicket(t.id); }} />)}</div>
      )}
      <div className="muted">{fleet.url === 'simulated' ? 'Simulated droids' : fleet.url} · {ago(fleet.at)} ago</div>
    </div>
  );
}

function JobLine({ j, onOpen }: { j: ScarifFleet['queued'][number]; onOpen: () => void }) {
  return (
    <div className="row jobline">
      <button className="linkish mono" onClick={onOpen}>{j.key}</button>
      <span className="grow ellipsis">{j.summary}</span>
      <span className={`chip ${j.needsHuman ? 'warn' : ''}`}>{j.status.replace(/_/g, ' ')}</span>
      {j.url !== '#' && <a href={j.url} target="_blank" rel="noreferrer">↗</a>}
    </div>
  );
}
