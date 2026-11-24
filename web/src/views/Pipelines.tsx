import { useEffect, useState } from 'react';
import { api } from '../api';
import { DecisionCard } from '../components/Attention';
import { STAGE_META, ago, money } from '../meta';
import { useFactory } from '../state';
import { useUI } from '../ui';
import { PIPELINE_STAGES, type Pipeline, type PipelineStage, type StoryDraft, type TicketDraft } from '../types';

const LABEL: Record<PipelineStage, { label: string; who: string }> = {
  scope: { label: 'Scope', who: 'you' },
  stories: { label: 'Stories', who: 'you validate' },
  tickets: { label: 'Tickets', who: 'you validate' },
  plan: { label: 'Plan', who: 'factory' },
  execution: { label: 'Execution', who: 'agents' },
  validation: { label: 'Validation', who: 'you validate' },
  done: { label: 'Done', who: '' },
};

/** Delivery pipelines: from a rough scope to shipped work, with you validating stories, tickets and the result. */
export function Pipelines() {
  const f = useFactory();
  const ui = useUI();
  const [selected, setSelected] = useState<string | null>(ui.focused.pipeline ?? null);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (ui.focused.pipeline) { setSelected(ui.focused.pipeline); setCreating(false); } }, [ui.focused.pipeline]);
  const current = creating ? undefined : f.pipelines.find((p) => p.id === selected) ?? f.pipelines[0];

  return (
    <div className="sessions">
      <div className="slist">
        <button className="btn primary" onClick={() => setCreating(true)}>＋ New pipeline</button>
        {f.pipelines.map((p) => (
          <button key={p.id} className={`srow ${current?.id === p.id ? 'on' : ''}`} onClick={() => { setSelected(p.id); setCreating(false); }}>
            <div className="row"><strong className="grow ellipsis">{p.title}</strong>{p.status[p.stage] === 'waiting' && <span className="count" title="Waiting on you">!</span>}</div>
            <Stepper p={p} mini />
            <div className="small muted row"><span>{LABEL[p.stage].label}</span><span className="grow" /><span>{ago(p.updatedAt)}</span></div>
          </button>
        ))}
        {!f.pipelines.length && !creating && <div className="small muted">No pipelines yet.</div>}
      </div>
      <div className="sdetail">
        {creating || !current ? <NewPipeline onCreated={(id) => { setSelected(id); setCreating(false); }} onCancel={f.pipelines.length ? () => setCreating(false) : undefined} /> : <PipelineDetail key={current.id} p={current} />}
      </div>
    </div>
  );
}

function Stepper({ p, mini }: { p: Pipeline; mini?: boolean }) {
  return (
    <div className={`stepper ${mini ? 'mini' : ''}`}>
      {PIPELINE_STAGES.map((k) => (
        <div key={k} className={`step ${p.status[k]} ${p.stage === k ? 'cur' : ''}`} title={`${LABEL[k].label}: ${p.status[k].replace('_', ' ')}`}>
          <span className="pip" />
          {!mini && <span className="small">{LABEL[k].label}<em>{LABEL[k].who}</em></span>}
        </div>
      ))}
    </div>
  );
}

function NewPipeline({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel?: () => void }) {
  const f = useFactory();
  const ui = useUI();
  const s = f.settings;
  const [projectId, setProjectId] = useState(f.targetProjectId);
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState('');
  const [jira, setJira] = useState(false);
  const [scarif, setScarif] = useState(!!(s?.scarif.enabled && s.scarif.useForPipelines));
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const p = await api.startPipeline({ projectId, title: title || undefined, scope, createInJira: jira, useScarif: scarif });
      onCreated(p.id);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
      <h2 style={{ margin: 0 }}>🛤 New delivery pipeline</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Describe a piece of work in your own words — bullet points are fine. The factory drafts user stories, then tickets, then runs them. You validate three times: the stories, the tickets, and the finished work.
        {f.engine?.pluginDirs.length ? ' Drafts follow your process plugin’s story and ticket rules.' : ''}
      </p>
      <div className="row wrap">
        <select className="select" style={{ width: 'auto' }} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {f.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input className="input grow" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <textarea className="textarea" style={{ minHeight: 160 }} autoFocus placeholder={'e.g.\n- Users can invite teammates by email\n- Invites expire after 7 days\n- Admins see pending invites and can revoke them'} value={scope} onChange={(e) => setScope(e.target.value)} />
      <div className="row wrap small">
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={jira} onChange={(e) => setJira(e.target.checked)} /> Create the tickets in Jira{s?.connectors.jira.projectKey ? ` (${s.connectors.jira.projectKey})` : ''}</label>
        <label className="row" style={{ gap: 6 }} title="Tickets with a Jira key and ≤ the point limit go to Scarif droids; the rest run here"><input type="checkbox" checked={scarif} onChange={(e) => setScarif(e.target.checked)} /> Send tickets that fit to Scarif</label>
      </div>
      <div className="row">
        <button className="btn primary" disabled={!scope.trim() || busy} onClick={go}>Start pipeline</button>
        {onCancel && <button className="btn ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

function PipelineDetail({ p }: { p: Pipeline }) {
  const f = useFactory();
  const ui = useUI();
  const project = f.projects.find((x) => x.id === p.projectId);
  const items = f.attention.filter((a) => a.pipelineId === p.id && a.status === 'open' && a.key.endsWith(':validation'));
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) ui.toast(done);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };
  const waiting = p.status[p.stage] === 'waiting';
  return (
    <div className="card sdcard">
      <header className="row wrap">
        <h2 style={{ margin: 0 }} className="grow">{p.title}</h2>
        {project && <span className="chip">{project.name}</span>}
        {p.createInJira && <span className="chip">◆ Jira</span>}
        {p.useScarif && <span className="chip">🛰 Scarif</span>}
        {p.costUsd > 0 && <span className="chip">{money(p.costUsd)}</span>}
        <button className="btn sm ghost" onClick={() => confirm('Delete this pipeline? Tickets already on the board stay.') && act(() => api.deletePipeline(p.id))}>🗑</button>
      </header>
      <Stepper p={p} />
      {p.status[p.stage] === 'blocked' && (
        <div className="banner bad row"><span className="grow">{p.error ?? 'Blocked.'}</span><button className="btn sm" onClick={() => act(() => api.retryPipeline(p.id), 'Retrying')}>↻ Retry</button></div>
      )}
      {p.status[p.stage] === 'running' && <div className="banner">⏳ {p.stage === 'stories' ? 'Drafting user stories…' : p.stage === 'tickets' ? 'Breaking the stories into tickets…' : p.stage === 'plan' ? 'Planning…' : 'The agents are working the tickets.'}</div>}

      <details className="scope"><summary className="small muted">Scope</summary><div className="pre small">{p.scope}</div></details>

      {(p.stage === 'stories' || p.stories.length > 0) && <StoriesBlock p={p} editable={p.stage === 'stories' && waiting} />}
      {(p.stage === 'tickets' || p.tickets.length > 0) && p.stage !== 'stories' && <TicketsBlock p={p} editable={p.stage === 'tickets' && waiting} />}
      {waiting && (p.stage === 'stories' || p.stage === 'tickets') && <GateBar p={p} />}
      {items.map((a) => <DecisionCard key={a.id} item={a} showTicket={false} />)}
      {p.stage === 'done' && <div className="banner ok">🎉 Validated and done.</div>}

      <details>
        <summary className="small muted">Log ({p.log.length})</summary>
        <div className="small" style={{ display: 'grid', gap: 2, marginTop: 6 }}>{p.log.slice().reverse().map((l, i) => <div key={i}><span className="muted">{ago(l.at)} ago</span> · {l.text}</div>)}</div>
      </details>
    </div>
  );
}

function GateBar({ p }: { p: Pipeline }) {
  const ui = useUI();
  const [note, setNote] = useState('');
  const what = p.stage === 'stories' ? 'stories' : 'tickets';
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      ui.toast(done);
      setNote('');
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };
  return (
    <div className="gatebar">
      <textarea className="textarea" style={{ minHeight: 40 }} placeholder={`What should change about the ${what}? (needed to send back)`} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="row">
        <button className="btn ok" onClick={() => run(() => api.approvePipeline(p.id, p.stage), p.stage === 'tickets' ? 'Approved — tickets are going on the board' : 'Approved — drafting tickets')}>✓ Approve {what}</button>
        <button className="btn" disabled={!note.trim()} onClick={() => run(() => api.sendBackPipeline(p.id, note, p.stage), 'Sent back — redrafting')}>↩ Send back</button>
      </div>
    </div>
  );
}

function StoriesBlock({ p, editable }: { p: Pipeline; editable: boolean }) {
  const ui = useUI();
  const [draft, setDraft] = useState<StoryDraft[]>(p.stories);
  useEffect(() => setDraft(p.stories), [p.stories]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(p.stories);
  const save = () => api.editPipeline(p.id, { stories: draft }).then(() => ui.toast('Saved')).catch((e) => ui.toast(`⚠ ${e.message}`));
  const upd = (i: number, patch: Partial<StoryDraft>) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <section>
      <h3 className="sect">📖 User stories ({p.stories.length})</h3>
      <div className="drafts">
        {draft.map((s, i) => (
          <div key={s.id} className="draft">
            {editable ? (
              <>
                <div className="row"><input className="input grow" value={s.title} onChange={(e) => upd(i, { title: e.target.value })} /><button className="btn sm ghost" title="Remove" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}>✕</button></div>
                <textarea className="textarea small" style={{ minHeight: 40 }} value={s.story} onChange={(e) => upd(i, { story: e.target.value })} />
                <textarea className="textarea small" style={{ minHeight: 52 }} value={s.criteria.join('\n')} placeholder="Acceptance criteria, one per line" onChange={(e) => upd(i, { criteria: e.target.value.split('\n') })} />
              </>
            ) : (
              <>
                <strong>{i + 1}. {s.title}</strong>
                <div className="small">{s.story}</div>
                <ul className="small crit">{s.criteria.map((c, j) => <li key={j}>{c}</li>)}</ul>
              </>
            )}
          </div>
        ))}
      </div>
      {editable && (
        <div className="row">
          <button className="btn sm" onClick={() => setDraft((d) => [...d, { id: Math.random().toString(36).slice(2, 10), title: 'New story', story: 'As a …, I want …, so that …', criteria: [] }])}>＋ Story</button>
          {dirty && <button className="btn sm primary" onClick={save}>Save edits</button>}
        </div>
      )}
    </section>
  );
}

function TicketsBlock({ p, editable }: { p: Pipeline; editable: boolean }) {
  const f = useFactory();
  const ui = useUI();
  const [draft, setDraft] = useState<TicketDraft[]>(p.tickets);
  useEffect(() => setDraft(p.tickets), [p.tickets]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(p.tickets);
  const save = () => api.editPipeline(p.id, { tickets: draft }).then(() => ui.toast('Saved')).catch((e) => ui.toast(`⚠ ${e.message}`));
  const upd = (i: number, patch: Partial<TicketDraft>) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const num = (id: string) => draft.findIndex((x) => x.id === id) + 1;
  const points = draft.reduce((a, t) => a + t.points, 0);
  const waveOf = (id: string) => (p.plan?.waves.findIndex((w) => w.includes(id)) ?? -1) + 1;

  return (
    <section>
      <h3 className="sect">🎫 Tickets ({p.tickets.length} · {points} pts){p.plan && <span className="small muted"> — {p.plan.summary}</span>}</h3>
      <div className="drafts">
        {draft.map((t, i) => {
          const board = t.ticketId ? f.allTickets.find((x) => x.id === t.ticketId) : undefined;
          return (
            <div key={t.id} className="draft">
              {editable ? (
                <>
                  <div className="row">
                    <span className="mono small muted">{i + 1}</span>
                    <input className="input grow" value={t.title} onChange={(e) => upd(i, { title: e.target.value })} />
                    <select className="select" style={{ width: 'auto' }} value={t.points} title="Agent points" onChange={(e) => upd(i, { points: Number(e.target.value) })}>
                      {[1, 2, 3, 5, 8, 13].map((n) => <option key={n} value={n}>{n} pts</option>)}
                    </select>
                    <button className="btn sm ghost" title="Remove" onClick={() => setDraft((d) => d.filter((_, j) => j !== i).map((x) => ({ ...x, dependsOn: x.dependsOn.filter((y) => y !== t.id) })))}>✕</button>
                  </div>
                  <textarea className="textarea small" style={{ minHeight: 40 }} value={t.description} onChange={(e) => upd(i, { description: e.target.value })} />
                  <textarea className="textarea small" style={{ minHeight: 48 }} value={t.criteria.join('\n')} placeholder="Acceptance criteria, one per line" onChange={(e) => upd(i, { criteria: e.target.value.split('\n') })} />
                  <div className="row wrap small">
                    <span className="muted">After:</span>
                    {draft.filter((x) => x.id !== t.id).map((x) => (
                      <label key={x.id} className="row" style={{ gap: 3 }}>
                        <input type="checkbox" checked={t.dependsOn.includes(x.id)} onChange={(e) => upd(i, { dependsOn: e.target.checked ? [...t.dependsOn, x.id] : t.dependsOn.filter((y) => y !== x.id) })} />{num(x.id)}
                      </label>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="row wrap">
                    <strong className="grow">{i + 1}. {t.title}</strong>
                    <span className="chip">{t.points} pts</span>
                    {waveOf(t.id) > 0 && <span className="chip" title="Runs in this wave">wave {waveOf(t.id)}</span>}
                    {t.route && <span className="chip" title={t.routeWhy}>{t.route === 'scarif' ? '🛰 Scarif' : '🏭 Local'}</span>}
                    {t.jiraKey && <span className="chip mono">{t.jiraKey}</span>}
                    {board && <button className="chip linkish" onClick={() => ui.openTicket(board.id)}>{board.key} · {STAGE_META[board.stage].icon} {STAGE_META[board.stage].label}</button>}
                  </div>
                  {t.dependsOn.length > 0 && <div className="small muted">After {t.dependsOn.map(num).filter(Boolean).join(', ')}</div>}
                  <ul className="small crit">{t.criteria.map((c, j) => <li key={j}>{c}</li>)}</ul>
                </>
              )}
            </div>
          );
        })}
      </div>
      {editable && (
        <div className="row">
          <button className="btn sm" onClick={() => setDraft((d) => [...d, { id: Math.random().toString(36).slice(2, 10), title: 'New ticket', description: '', criteria: [], points: 3, storyIds: [], dependsOn: [] }])}>＋ Ticket</button>
          {dirty && <button className="btn sm primary" onClick={save}>Save edits</button>}
          {draft.some((t) => t.points > 8) && <span className="small muted">Tickets over 8 points are worth splitting.</span>}
        </div>
      )}
    </section>
  );
}
