import { QualityPanel, ShipPanel } from './Quality';
import { AskTicket, Dependencies, Forecast, HandOff, WaitingBanner } from './DevTools';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useFactory } from '../state';
import { useHarvest } from '../harvest';
import { useUI } from '../ui';
import { ACTIVE_STAGES, PRIORITY_META, SOURCE_META, STAGE_META, ago, compact, duration, money } from '../meta';
import type { LogEvent, Priority, Ticket } from '../types';
import { AgentPill } from './Bits';
import { DecisionCard } from './Attention';
import { Diff } from './Diff';
import { HarvestPanel } from './HarvestPanel';
import { FileViewer, PreviewControls } from './FileViewer';
import { ProjectTag } from './Bits';

type Tab = 'overview' | 'live' | 'diff' | 'files' | 'quality' | 'ask';

export function TicketDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { tickets, logs: allLogs, agents, attention } = useFactory();
  const hv = useHarvest();
  const ui = useUI();
  const t = tickets.find((x) => x.id === id);
  const [tab, setTab] = useState<Tab>('overview');
  const [history, setHistory] = useState<LogEvent[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.ticketLogs(id).then(setHistory).catch(() => {});
  }, [id]);

  const items = attention.filter((a) => a.ticketId === id && (a.status === 'open' || a.status === 'held'));
  const needsYou = items.some((a) => a.status === 'open');
  // Opening a ticket that needs you starts your Harvest review timer (if auto-timers are on).
  useEffect(() => {
    if (needsYou) hv.autoStart(id, 'PM review');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, needsYou]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!t) return null;

  // merge fetched history with live events
  const seen = new Set(history.map((l) => l.id));
  const logs = [...history, ...allLogs.filter((l) => l.ticketId === id && !seen.has(l.id))];
  const live = ACTIVE_STAGES.includes(t.stage);

  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (msg) ui.toast(msg);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const save = (patch: Partial<Ticket>) => act(() => api.updateTicket(t.id, patch));
  const color = (role?: string) => agents.find((a) => a.role === role)?.color;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={t.title}>
        <div className="drawer-h">
          <div className="row small muted">
            <span className="mono">{t.key}</span>
            <ProjectTag projectId={t.projectId} />
            <span>·</span>
            <span>{STAGE_META[t.stage].icon} {STAGE_META[t.stage].label}</span>
            {t.activeAgent && live && <AgentPill role={t.activeAgent} live />}
            {t.externalUrl && <a href={t.externalUrl} target="_blank" rel="noreferrer">{SOURCE_META[t.source].icon} Open in {SOURCE_META[t.source].label} ↗</a>}
            <span style={{ flex: 1 }} />
            <button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button>
          </div>
          <input className="title" defaultValue={t.title} key={t.id + t.title} onBlur={(e) => e.target.value !== t.title && save({ title: e.target.value })} />
          <div className="row wrap">
            <select className="select" style={{ width: 'auto' }} value={t.priority} onChange={(e) => save({ priority: e.target.value as Priority })}>
              {Object.entries(PRIORITY_META).map(([k, v]) => <option key={k} value={k}>{v.label} priority</option>)}
            </select>
            {t.stage === 'backlog' && <button className="btn primary" disabled={busy} onClick={() => act(() => api.updateTicket(t.id, { stage: 'ready' }), 'Sent to the factory')}>▶ Send to factory</button>}
            {t.stage === 'ready' && <button className="btn" disabled={busy} onClick={() => act(() => api.updateTicket(t.id, { stage: 'backlog' }))}>⏸ Back to backlog</button>}
            {live && <button className="btn danger" disabled={busy} onClick={() => act(() => api.cancel(t.id), 'Cancelled')}>■ Stop agents</button>}
            {t.stage === 'failed' && <button className="btn primary" disabled={busy} onClick={() => act(() => api.retry(t.id), 'Re-queued')}>↻ Retry</button>}
            {t.prUrl && <a className="btn" href={t.prUrl} target="_blank" rel="noreferrer">View PR ↗</a>}
            {(t.worktree || t.preview) && <PreviewControls t={t} compact />}
            {t.stage !== 'manual' && <HandOff t={t} />}
            <span style={{ flex: 1 }} />
            <button className="btn ghost sm danger" onClick={() => confirm(`Delete ${t.key}?`) && act(async () => { await api.deleteTicket(t.id); onClose(); }, 'Deleted')}>Delete</button>
          </div>
        </div>

        {items.length > 0 && (
          <div className="drawer-items">
            {items.map((a) => <DecisionCard key={a.id} item={a} showTicket={false} />)}
          </div>
        )}

        <nav className="tabs">
          {(['overview', 'live', 'diff', 'files', 'quality', 'ask'] as Tab[]).map((k) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {{ overview: 'Overview', live: `Agent log${live ? ' ●' : ''}`, diff: 'Diff', files: 'Files', quality: 'Tests & review', ask: `Ask${t.chat?.length ? ` (${t.chat.length})` : ''}` }[k]}
            </button>
          ))}
        </nav>

        <div className="drawer-b">
          {tab === 'overview' && (
            <>
              {t.stage === 'manual' && <HandOff t={t} />}
              <WaitingBanner t={t} />
              <Forecast t={t} />
              <label className="field">Description
                <textarea className="textarea" style={{ minHeight: 120 }} defaultValue={t.description} key={t.id + 'd'} onBlur={(e) => e.target.value !== t.description && save({ description: e.target.value })} />
              </label>
              {t.error && <div className="banner" style={{ margin: 0 }}>⚠ {t.error}</div>}
              <Dependencies t={t} />
              <ShipPanel t={t} />
              {(t.ci || t.prNumber) && (
                <div>
                  <strong>🚦 CI {t.prNumber ? <>on {t.prUrl ? <a href={t.prUrl} target="_blank" rel="noreferrer">PR #{t.prNumber} ↗</a> : `PR #${t.prNumber}`}</> : ''}</strong>
                  <div className="row wrap" style={{ marginTop: 6 }}>
                    <span className={`chip ci-${t.ci?.state ?? 'none'}`}>{{ pending: '⏳ running', success: '✅ green', failure: '❌ red', none: '— no checks' }[t.ci?.state ?? 'none']}</span>
                    {t.ci?.checks.map((c) => (
                      <a key={c.name} className={`chip ci-${c.state}`} href={c.url} target="_blank" rel="noreferrer">{c.state === 'success' ? '✓' : c.state === 'failure' ? '✗' : '…'} {c.name}</a>
                    ))}
                  </div>
                </div>
              )}
              <HarvestPanel t={t} />
              {t.plan && (
                <div className="plan">
                  <strong>🧭 Plan</strong>
                  <p style={{ margin: '6px 0' }}>{t.plan.summary}</p>
                  <ol>{t.plan.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                  {t.plan.risks.length > 0 && <p className="small"><strong>Risks:</strong> {t.plan.risks.join(' · ')}</p>}
                  {t.plan.files.length > 0 && <p className="small mono muted">{t.plan.files.join('  ')}</p>}
                </div>
              )}
              <div>
                <strong>📌 PM notes</strong>
                <div className="small muted">Every agent sees these as top-priority instructions.</div>
                {t.notes.map((n) => <div key={n.id} className="cmt" style={{ borderColor: 'var(--accent)' }}>{n.text} <span className="muted small">· {ago(n.ts)} ago</span></div>)}
                <div className="row" style={{ marginTop: 8 }}>
                  <input className="input" placeholder="Add an instruction, e.g. “use the existing date util”" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && note.trim() && act(() => api.note(t.id, note), 'Note added').then(() => setNote(''))} />
                  <button className="btn" disabled={!note.trim()} onClick={() => act(() => api.note(t.id, note), 'Note added').then(() => setNote(''))}>Add</button>
                </div>
              </div>
              <dl className="kv">
                <dt>Source</dt><dd>{SOURCE_META[t.source].icon} {SOURCE_META[t.source].label}</dd>
                {t.branch && <><dt>Branch</dt><dd className="mono">{t.branch}</dd></>}
                <dt>Spend</dt><dd>{money(t.costUsd)} · {compact(t.tokens)} tokens</dd>
                <dt>Rework loops</dt><dd>{t.iterations}</dd>
                <dt>Created</dt><dd>{ago(t.createdAt)} ago</dd>
                {t.startedAt && <><dt>Cycle time</dt><dd>{duration((t.finishedAt ?? Date.now()) - t.startedAt)}</dd></>}
                <dt>Labels</dt>
                <dd><input className="input" defaultValue={t.labels.join(', ')} key={t.id + 'l'} placeholder="comma separated" onBlur={(e) => save({ labels: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></dd>
              </dl>
            </>
          )}

          {tab === 'live' && <LogView logs={logs} color={color} />}
          {tab === 'diff' && <Diff text={t.diff ?? ''} />}
          {tab === 'files' && <FileViewer t={t} />}
          {tab === 'ask' && <AskTicket t={t} />}
          {tab === 'quality' && (
            <>
              <QualityPanel t={t} open />
              {(t.artifacts?.length ?? 0) > 0 && (
                <div>
                  <strong>📸 Screenshots</strong>
                  <div className="shots">
                    {t.artifacts!.map((a) => (
                      <a key={a.id} href={api.artifactUrl(t.id, a.id)} target="_blank" rel="noreferrer" title={a.caption ?? a.name}>
                        <img src={api.artifactUrl(t.id, a.id)} alt={a.caption ?? a.name} />
                        <span className="small muted">{a.caption ?? a.name}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <strong>🧪 Tests</strong>
                {t.testReport ? (
                  <div className="cmt" style={{ borderColor: t.testReport.passed ? 'var(--ok)' : 'var(--bad)' }}>
                    <strong>{t.testReport.passed ? 'Passed' : 'Failed'}</strong> — {t.testReport.summary}
                    {t.testReport.failures.map((f, i) => <div key={i} className="mono small" style={{ color: 'var(--bad)' }}>{f}</div>)}
                  </div>
                ) : <div className="muted small">No test run yet.</div>}
              </div>
              <div>
                <strong>🔍 Review</strong>
                {t.review ? (
                  <>
                    <div className="cmt" style={{ borderColor: t.review.verdict === 'approve' ? 'var(--ok)' : 'var(--warn)' }}>
                      <strong>{t.review.verdict === 'approve' ? 'Approved' : 'Changes requested'}</strong> — {t.review.summary}
                    </div>
                    {t.review.comments.map((c, i) => (
                      <div key={i} className={`cmt ${c.severity}`}>
                        <span className="badge" style={{ background: 'var(--bg2)' }}>{c.severity}</span>{' '}
                        {c.file && <span className="mono small">{c.file}{c.line ? `:${c.line}` : ''}</span>} {c.comment}
                      </div>
                    ))}
                  </>
                ) : <div className="muted small">No review yet.</div>}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function LogView({ logs, color }: { logs: LogEvent[]; color: (r?: string) => string | undefined }) {
  const end = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow) end.current?.scrollIntoView({ block: 'end' });
  }, [logs.length, follow]);
  if (!logs.length) return <div className="empty">No agent activity yet.</div>;
  return (
    <div>
      <label className="row small muted" style={{ marginBottom: 8 }}><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow</label>
      <div className="log">
        {logs.map((l) => (
          <div key={l.id} className={`ln ${l.kind}`}>
            <span className="ts">{new Date(l.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }).slice(0, 8)}</span>
            <span className="who" style={{ color: color(l.agent) ?? 'var(--muted)' }}>{l.agent}</span>
            <span className="msg">{l.kind === 'tool' ? '↳ ' : ''}{l.text}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
