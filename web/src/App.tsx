import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Widgets } from './components/Bits';
import { CommandPalette, NewTicket } from './components/Modals';
import { TicketDrawer } from './components/TicketDrawer';
import { usePrefs, type View } from './prefs';
import { useFactory } from './state';
import { UICtx, type UI } from './ui';
import type { Stage } from './types';
import { Activity } from './views/Activity';
import { Agents } from './views/Agents';
import { Board } from './views/Board';
import { Office } from './views/office/Office';
import { Settings } from './views/Settings';

const NAV: Array<{ v: View; icon: string; label: string; key: string }> = [
  { v: 'office', icon: '🏢', label: 'Office', key: 'o' },
  { v: 'board', icon: '📋', label: 'Board', key: 'b' },
  { v: 'agents', icon: '🤖', label: 'Agents', key: 'a' },
  { v: 'activity', icon: '📜', label: 'Activity', key: 'l' },
  { v: 'settings', icon: '⚙️', label: 'Settings', key: 's' },
];

export function App() {
  const { prefs } = usePrefs();
  const f = useFactory();
  const [view, setView] = useState<View>(() => (location.hash.slice(1) as View) || prefs.defaultView);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState<Stage | null>(null);
  const [palette, setPalette] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const toastTimer = useRef<number>();
  const search = useRef<HTMLInputElement>(null);
  const gPending = useRef(false);

  const go = useCallback((v: View) => {
    setView(v);
    history.replaceState(null, '', `#${v}`);
  }, []);

  const ui: UI = {
    view,
    go,
    openTicket: setOpen,
    newTicket: (s) => setCreating(s ?? 'backlog'),
    toast: (m) => {
      setToast(m);
      window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setToast(null), 2800);
    },
    palette: () => setPalette(true),
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement).tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (gPending.current) {
        gPending.current = false;
        const n = NAV.find((x) => x.key === e.key);
        if (n) go(n.v);
        return;
      }
      if (e.key === 'g') { gPending.current = true; setTimeout(() => (gPending.current = false), 800); }
      if (e.key === 'n') { e.preventDefault(); setCreating('backlog'); }
      if (e.key === '/' && view === 'board') { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, go]);

  const awaiting = f.tickets.filter((t) => t.stage === 'awaiting_approval').length;
  const title = NAV.find((n) => n.v === view)?.label;

  return (
    <UICtx.Provider value={ui}>
      <div className="shell">
        <nav className="sidebar">
          <div className="brand">
            <span className="logo">🏭</span>
            <span>AI Dev Factory<small>{f.settings?.mode === 'live' ? 'Live agents' : 'Simulated agents'}</small></span>
          </div>
          {NAV.map((n) => (
            <button key={n.v} className={`nav-btn ${view === n.v ? 'active' : ''}`} onClick={() => go(n.v)}>
              <span>{n.icon}</span> {n.label}
              {n.v === 'board' && awaiting > 0 ? <span className="count" title="Waiting on you">{awaiting}</span> : <kbd>g {n.key}</kbd>}
            </button>
          ))}
          <div className="spacer" />
          <button className="nav-btn" onClick={() => setPalette(true)}>⌘ Command palette <kbd>⌘K</kbd></button>
          <button className="nav-btn" onClick={() => setCreating('backlog')}>＋ New ticket <kbd>n</kbd></button>
          <div className="conn"><span className={`dot ${f.connected ? 'on' : ''}`} /> {f.connected ? (f.factory.paused ? 'Paused' : `${f.factory.running.length} running`) : 'Reconnecting…'}</div>
        </nav>

        <main className="main">
          <header className="topbar">
            <h1>{title}</h1>
            {view === 'board' && <input ref={search} className="input" style={{ maxWidth: 260 }} placeholder="Filter tickets…  /" value={filter} onChange={(e) => setFilter(e.target.value)} />}
            <span className="grow" />
            {awaiting > 0 && <button className="btn" onClick={() => setOpen(f.tickets.find((t) => t.stage === 'awaiting_approval')!.id)}>✋ {awaiting} waiting on you</button>}
            <button className="btn" onClick={() => api.pause(!f.factory.paused)}>{f.factory.paused ? '▶ Resume' : '⏸ Pause'}</button>
            <button className="btn primary" onClick={() => setCreating('ready')}>＋ New ticket</button>
          </header>
          {(view === 'board' || view === 'office') && <Widgets />}
          {f.settings?.mode === 'mock' && view !== 'settings' && f.tickets.length > 0 && (
            <div className="banner">🎭 Simulated agents — nothing touches your code. Point the factory at a repo and switch to Live in <a href="#settings" onClick={(e) => { e.preventDefault(); go('settings'); }}>Settings</a>.</div>
          )}
          <div className="content">
            {!f.ready ? <div className="empty">Connecting to the factory…</div> : (
              <>
                {view === 'office' && <Office />}
                {view === 'board' && <Board filter={filter} />}
                {view === 'agents' && <Agents />}
                {view === 'activity' && <Activity />}
                {view === 'settings' && <Settings />}
              </>
            )}
          </div>
        </main>
      </div>

      {open && <TicketDrawer id={open} onClose={() => setOpen(null)} />}
      {creating && <NewTicket stage={creating} onClose={() => setCreating(null)} />}
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </UICtx.Provider>
  );
}
