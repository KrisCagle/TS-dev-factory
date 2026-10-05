import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useFactory } from '../state';
import { usePrefs, type View } from '../prefs';
import { useUI } from '../ui';
import { PRIORITY_META, STAGE_META } from '../meta';
import type { Priority, Stage } from '../types';

export function NewTicket({ stage, onClose }: { stage: Stage; onClose: () => void }) {
  const ui = useUI();
  const { projects, targetProjectId } = useFactory();
  const [mode, setMode] = useState<'write' | 'manual'>('write');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [labels, setLabels] = useState('');
  const [to, setTo] = useState<Stage>(stage === 'ready' ? 'ready' : 'backlog');
  const [projectId, setProjectId] = useState(targetProjectId);
  // ticket writer
  const [rough, setRough] = useState('');
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [drafted, setDrafted] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const draft = async (withAnswers: boolean) => {
    if (!rough.trim()) return;
    setDrafting(true);
    try {
      const d = await api.scope({
        text: rough,
        projectId,
        answers: withAnswers ? questions.map((q, i) => ({ q, a: answers[i]?.trim() || 'No preference — decide sensibly.' })) : undefined,
      });
      setTitle(d.title);
      setDescription(d.description);
      setPriority(d.priority);
      setLabels(d.labels.join(', '));
      setQuestions(withAnswers ? [] : d.questions);
      setAnswers([]);
      setDrafted(true);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    } finally {
      setDrafting(false);
    }
  };

  const submit = async () => {
    if (!title.trim()) return;
    try {
      const t = await api.createTicket({ title, description, priority, stage: to, projectId, labels: labels.split(',').map((s) => s.trim()).filter(Boolean) });
      ui.toast(`Created ${t.key}${to === 'ready' ? ' — queued for the factory' : ''}`);
      onClose();
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };

  const showForm = mode === 'manual' || drafted;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal card" style={{ width: 'min(680px, 94vw)', maxHeight: '84vh', overflowY: 'auto' }} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (showForm ? submit() : draft(false)); }}>
        <div className="row">
          <h3 style={{ flex: 1 }}>New ticket</h3>
          <div className="seg">
            <button className={mode === 'write' ? 'on' : ''} onClick={() => setMode('write')}>✨ Write it for me</button>
            <button className={mode === 'manual' ? 'on' : ''} onClick={() => setMode('manual')}>Write it myself</button>
          </div>
        </div>
        {projects.length > 1 && (
          <label className="field">Project
            <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}

        {mode === 'write' && (
          <>
            <textarea
              className="textarea"
              autoFocus
              style={{ minHeight: drafted ? 60 : 120 }}
              placeholder={'Paste anything — a rough idea, a bug report, a Slack thread…\ne.g. "customers say the invoice dates look weird, like 2026-09-30T00:00:00Z"'}
              value={rough}
              onChange={(e) => setRough(e.target.value)}
            />
            {questions.length > 0 && (
              <div className="hpanel">
                <strong className="small">The Scoper has {questions.length === 1 ? 'a question' : 'a couple of questions'} (optional):</strong>
                {questions.map((q, i) => (
                  <label key={i} className="field">{q}
                    <input className="input" value={answers[i] ?? ''} placeholder="Skip to let it decide" onChange={(e) => setAnswers((a) => { const n = a.slice(); n[i] = e.target.value; return n; })} />
                  </label>
                ))}
                <div className="row"><button className="btn sm primary" disabled={drafting} onClick={() => draft(true)}>{drafting ? 'Updating…' : 'Update the draft'}</button></div>
              </div>
            )}
            {!drafted && (
              <div className="row">
                <span className="small muted" style={{ flex: 1 }}>It writes a title, acceptance criteria, priority and labels{'—'}you can edit everything before creating.</span>
                <button className="btn primary" disabled={!rough.trim() || drafting} onClick={() => draft(false)}>{drafting ? 'Drafting…' : '✨ Draft ticket'}</button>
              </div>
            )}
          </>
        )}

        {showForm && (
          <>
            <input className="input" autoFocus={mode === 'manual'} placeholder="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea className="textarea mono" style={{ minHeight: 180, fontSize: 12.5 }} placeholder="Context, acceptance criteria, links… The more specific, the better the agents do." value={description} onChange={(e) => setDescription(e.target.value)} />
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
          </>
        )}
      </div>
    </>
  );
}

interface Cmd { id: string; label: string; hint?: string; icon: string; run: () => void }

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { tickets, factory, connectors, settings, projects, targetProjectId } = useFactory();
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
      { id: 'demo', label: 'Load demo tickets', icon: '🎲', run: () => api.demo(targetProjectId) },
      go('reports', 'Go to Reports', '📊', ''),
      go('rules', 'Go to House rules', '📐', ''),
      go('trophies', 'Go to the Trophy room', '🏆', 'g t'),
      ...projects.map((p) => ({ id: `proj-${p.id}`, label: `Switch to project: ${p.name}`, icon: '🗂', run: () => set({ activeProject: p.id }) })),
      ...(projects.length > 1 ? [{ id: 'proj-all', label: 'Show all projects', icon: '🗂', run: () => set({ activeProject: 'all' }) }] : []),
      ...connectors.filter((c) => c.enabled).map((c) => ({ id: `sync-${c.source}`, label: `Sync from ${c.label}`, icon: '⟳', run: () => api.sync(c.source, targetProjectId).then((r) => ui.toast(`${c.label}: ${r.created} new of ${r.fetched}`)) })),
    ];
    const tix: Cmd[] = tickets.map((t) => ({ id: t.id, label: `${t.key} ${t.title}`, icon: STAGE_META[t.stage].icon, hint: STAGE_META[t.stage].label, run: () => ui.openTicket(t.id) }));
    const all = [...base, ...tix];
    const needle = q.toLowerCase().trim();
    if (!needle) return all.slice(0, 40);
    return all.filter((c) => needle.split(/\s+/).every((w) => c.label.toLowerCase().includes(w))).slice(0, 40);
  }, [q, tickets, factory.paused, prefs, connectors, settings?.mode, projects, targetProjectId]);

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
