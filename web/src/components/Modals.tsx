import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useFactory } from '../state';
import { usePrefs, type View } from '../prefs';
import { useUI } from '../ui';
import { PRIORITY_META, STAGE_META } from '../meta';
import type { Priority, Stage } from '../types';

export function NewTicket({ stage, onClose }: { stage: Stage; onClose: () => void }) {
  const ui = useUI();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [labels, setLabels] = useState('');
  const [to, setTo] = useState<Stage>(stage === 'ready' ? 'ready' : 'backlog');

  const submit = async () => {
    if (!title.trim()) return;
    try {
      const t = await api.createTicket({ title, description, priority, stage: to, labels: labels.split(',').map((s) => s.trim()).filter(Boolean) });
      ui.toast(`Created ${t.key}${to === 'ready' ? ' — queued for the factory' : ''}`);
      onClose();
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal card" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}>
        <h3>New ticket</h3>
        <input className="input" autoFocus placeholder="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="textarea" placeholder="Context, acceptance criteria, links… The more specific, the better the agents do." value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="grid2">
          <label className="field">Priority
            <select className="select" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {Object.entries(PRIORITY_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
          <label className="field">Labels
            <input className="input" placeholder="frontend, bug" value={labels} onChange={(e) => setLabels(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <div className="seg">
            <button className={to === 'backlog' ? 'on' : ''} onClick={() => setTo('backlog')}>Backlog</button>
            <button className={to === 'ready' ? 'on' : ''} onClick={() => setTo('ready')}>Send to factory now</button>
          </div>
          <span style={{ flex: 1 }} />
          <span className="small muted"><kbd>⌘</kbd> <kbd>↵</kbd></span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!title.trim()} onClick={submit}>Create</button>
        </div>
      </div>
    </>
  );
}

interface Cmd { id: string; label: string; hint?: string; icon: string; run: () => void }

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { tickets, factory, connectors, settings } = useFactory();
  const { prefs, set } = usePrefs();
  const ui = useUI();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const cmds = useMemo<Cmd[]>(() => {
    const go = (v: View, label: string, icon: string, hint: string): Cmd => ({ id: `go-${v}`, label, icon, hint, run: () => ui.go(v) });
    const base: Cmd[] = [
      { id: 'new', label: 'New ticket', icon: '＋', hint: 'N', run: () => ui.newTicket() },
      go('inbox', 'Go to Needs you', '✋', 'G I'),
      go('office', 'Go to Office', '🏢', 'G O'),
      go('board', 'Go to Board', '📋', 'G B'),
      go('agents', 'Go to Agents', '🤖', 'G A'),
      go('activity', 'Go to Activity', '📜', ''),
      go('settings', 'Go to Settings', '⚙️', ''),
      { id: 'pause', label: factory.paused ? 'Resume the factory' : 'Pause the factory', icon: factory.paused ? '▶' : '⏸', run: () => api.pause(!factory.paused) },
      { id: 'theme', label: `Theme: switch to ${prefs.theme === 'dark' ? 'light' : 'dark'}`, icon: '🌓', run: () => set({ theme: prefs.theme === 'dark' ? 'light' : 'dark' }) },
      { id: 'density', label: `Density: ${prefs.density === 'compact' ? 'comfortable' : 'compact'}`, icon: '↕', run: () => set({ density: prefs.density === 'compact' ? 'comfortable' : 'compact' }) },
      { id: 'mode', label: `Switch to ${settings?.mode === 'live' ? 'mock' : 'live'} agents`, icon: '⚡', run: () => api.updateSettings({ mode: settings?.mode === 'live' ? 'mock' : 'live' }) },
      { id: 'demo', label: 'Load demo tickets', icon: '🎲', run: () => api.demo() },
      ...connectors.filter((c) => c.enabled).map((c) => ({ id: `sync-${c.source}`, label: `Sync from ${c.label}`, icon: '⟳', run: () => api.sync(c.source).then((r) => ui.toast(`${c.label}: ${r.created} new of ${r.fetched}`)) })),
    ];
    const tix: Cmd[] = tickets.map((t) => ({ id: t.id, label: `${t.key} ${t.title}`, icon: STAGE_META[t.stage].icon, hint: STAGE_META[t.stage].label, run: () => ui.openTicket(t.id) }));
    const all = [...base, ...tix];
    const needle = q.toLowerCase().trim();
    if (!needle) return all.slice(0, 40);
    return all.filter((c) => needle.split(/\s+/).every((w) => c.label.toLowerCase().includes(w))).slice(0, 40);
  }, [q, tickets, factory.paused, prefs, connectors, settings?.mode]);

  useEffect(() => setI(0), [q]);
  useEffect(() => {
    list.current?.children[i]?.scrollIntoView({ block: 'nearest' });
  }, [i]);

  const run = (c?: Cmd) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="palette card">
        <input
          autoFocus
          placeholder="Type a command or search tickets…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, cmds.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
            if (e.key === 'Enter') run(cmds[i]);
          }}
        />
        <ul ref={list}>
          {cmds.map((c, idx) => (
            <li key={c.id} className={idx === i ? 'on' : ''} onMouseEnter={() => setI(idx)} onClick={() => run(c)}>
              <span style={{ width: 20, textAlign: 'center' }}>{c.icon}</span>
              <span>{c.label}</span>
              {c.hint && <span className="hint">{c.hint}</span>}
            </li>
          ))}
          {!cmds.length && <li className="muted">No matches</li>}
        </ul>
      </div>
    </>
  );
}
