import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useHarvest } from '../harvest';
import { useFactory } from '../state';
import { useUI } from '../ui';
import { ago } from '../meta';
import type { AttentionItem, CaseVerdict } from '../types';
import { PreviewControls } from './FileViewer';

const KIND_META: Record<AttentionItem['kind'], { icon: string; label: string; color: string }> = {
  review: { icon: '🧾', label: 'Review', color: 'var(--accent)' },
  decision: { icon: '🤔', label: 'Decision', color: 'var(--warn)' },
  error: { icon: '⚠️', label: 'Error', color: 'var(--bad)' },
  todo: { icon: '☑️', label: 'To-do', color: 'var(--muted)' },
};

export function Brief({ item }: { item: AttentionItem }) {
  if (!item.brief) return null;
  const b = item.brief;
  return (
    <dl className="brief">
      <dt>Recommend</dt><dd><strong>{b.recommend}</strong></dd>
      <dt>Clears when</dt><dd>{b.clearsWhen}</dd>
      <dt>Why now</dt><dd>{b.whyNow}</dd>
      <dt>If it waits</dt><dd>{b.ifItWaits}</dd>
    </dl>
  );
}

/** One inbox item: context, the brief, and the choices. Reviews open the guided walkthrough. */
export function DecisionCard({ item, showTicket = true }: { item: AttentionItem; showTicket?: boolean }) {
  const { tickets } = useFactory();
  const ui = useUI();
  const hv = useHarvest();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [walking, setWalking] = useState(false);
  const t = tickets.find((x) => x.id === item.ticketId);
  const meta = KIND_META[item.kind];
  const held = item.status === 'held';

  const choose = async (optionId: string) => {
    setBusy(true);
    try {
      await api.resolve(item.id, { option: optionId, text: text.trim() || undefined });
      ui.toast(optionId === 'ship' || optionId === 'approve' ? 'Approved' : optionId === 'sendback' ? 'Sent back to the agents' : 'Done');
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (walking && item.review) return <ReviewWalkthrough item={item} onClose={() => setWalking(false)} />;

  return (
    <article className={`acard ${held ? 'held' : ''}`} style={{ ['--kind' as string]: meta.color }}>
      <header className="row">
        <span className="badge" style={{ background: 'color-mix(in srgb, var(--kind) 14%, transparent)', color: meta.color }}>{meta.icon} {meta.label}</span>
        {showTicket && t && <button className="linkish mono small" onClick={() => ui.openTicket(t.id)}>{t.key}</button>}
        <span className="small muted">{ago(item.createdAt)} ago</span>
        {held && <span className="chip" title={item.heldReason}>⏳ {item.heldReason ?? 'On hold'}</span>}
      </header>
      <h3>{item.title}</h3>
      {item.body && item.kind !== 'review' && <p className="abody">{item.body}</p>}
      {item.review && <p className="abody">{item.review.summary}</p>}
      <Brief item={item} />
      {!held && (
        <>
          {item.review && (
            <div className="row wrap">
              <button className="btn primary" onClick={() => { setWalking(true); if (t) hv.autoStart(t.id, 'PM review'); }}>
                ▶ Start review · {item.review.cases.length} case{item.review.cases.length === 1 ? '' : 's'}
              </button>
              <span className="small muted">or answer directly:</span>
            </div>
          )}
          <textarea
            className="textarea"
            style={{ minHeight: 48 }}
            placeholder={item.options?.some((o) => o.needsText) ? 'Direction for the agents (needed to send back)…' : 'Optional note for the agents…'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => t && hv.autoStart(t.id, item.kind === 'review' ? 'PM review' : 'PM decision')}
          />
          <div className="row wrap">
            {item.options?.map((o) => (
              <button
                key={o.id}
                className={`btn ${o.primary ? (o.id === 'ship' || o.id === 'approve' || o.id === 'retry' ? 'ok' : 'primary') : ''}`}
                disabled={busy || (o.needsText && !text.trim())}
                title={o.needsText && !text.trim() ? 'Write a note first' : undefined}
                onClick={() => choose(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </article>
  );
}

// ---------------------------------------------------------------- guided review

interface Draft {
  idx: number;              // -1 = setup, cases.length = summary
  verdicts: Array<CaseVerdict | undefined>;
  drafts: string[];
  notes: string;
}

const looksLikeCommand = (s: string) => /^(npm|npx|yarn|pnpm|git|cd|make|docker|bundle|rails|flutter|python|pip|go|cargo|curl|\.\/)\b/.test(s.trim());
const urlIn = (s: string) => s.match(/https?:\/\/\S+/)?.[0];

export function ReviewWalkthrough({ item, onClose }: { item: AttentionItem; onClose: () => void }) {
  const ui = useUI();
  const { allTickets } = useFactory();
  const ticket = allTickets.find((x) => x.id === item.ticketId);
  const shotsFor = (i: number) => (ticket?.artifacts ?? []).filter((a) => a.caseIndex === i);
  const looseShots = (ticket?.artifacts ?? []).filter((a) => a.caseIndex === undefined);
  const review = item.review!;
  const cases = review.cases;
  const storeKey = `walk:${item.id}`;
  const [d, setD] = useState<Draft>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey) ?? 'null');
      if (saved) return saved;
    } catch {
      /* ignore */
    }
    return { idx: review.setup.length ? -1 : 0, verdicts: [], drafts: [], notes: '' };
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(storeKey, JSON.stringify(d));
    } catch {
      /* private mode */
    }
  }, [d, storeKey]);

  const go = (idx: number) => setD((x) => ({ ...x, idx: Math.max(review.setup.length ? -1 : 0, Math.min(cases.length, idx)) }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/input|textarea/i.test((e.target as HTMLElement).tagName)) return;
      if (e.key === 'ArrowRight') go(d.idx + 1);
      if (e.key === 'ArrowLeft') go(d.idx - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const record = (i: number) => {
    const fb = (d.drafts[i] ?? '').trim();
    setD((x) => {
      const verdicts = x.verdicts.slice();
      verdicts[i] = fb ? { verdict: 'feedback', feedback: fb } : { verdict: 'approved' };
      return { ...x, verdicts, idx: Math.min(cases.length, i + 1) };
    });
  };

  const summary = useMemo(() => {
    const approved = cases.filter((_, i) => d.verdicts[i]?.verdict === 'approved').length;
    const feedback = cases.filter((_, i) => d.verdicts[i]?.verdict === 'feedback').length;
    const open = cases.length - approved - feedback;
    return { approved, feedback, open, ship: open === 0 && feedback === 0 && !d.notes.trim() };
  }, [d, cases]);

  const submit = async () => {
    setBusy(true);
    try {
      const verdicts: CaseVerdict[] = cases.map((_, i) => d.verdicts[i] ?? { verdict: 'approved' });
      await api.resolve(item.id, { verdicts, notes: d.notes.trim() || undefined });
      localStorage.removeItem(storeKey);
      ui.toast(summary.ship ? '🚀 Approved — shipping' : 'Feedback sent to the agents');
      onClose();
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const c = d.idx >= 0 && d.idx < cases.length ? cases[d.idx] : null;

  return (
    <article className="walk">
      <header className="row">
        <strong style={{ flex: 1 }}>🧾 {item.title}</strong>
        <button className="btn ghost sm" onClick={onClose}>Close</button>
      </header>
      <nav className="dots">
        {review.setup.length > 0 && <button className={`dot-b ${d.idx === -1 ? 'on' : ''}`} onClick={() => go(-1)} title="Setup">⚙</button>}
        {cases.map((cs, i) => {
          const v = d.verdicts[i]?.verdict;
          return (
            <button key={i} className={`dot-b ${v ?? ''} ${d.idx === i ? 'on' : ''}`} onClick={() => go(i)} title={cs.title}>
              {v === 'approved' ? '✓' : i + 1}
            </button>
          );
        })}
        <button className={`dot-b ${d.idx === cases.length ? 'on' : ''}`} onClick={() => go(cases.length)} title="Summary">∑</button>
      </nav>

      <div className="walk-body">
        <section className="walk-main">
          {d.idx === -1 && (
            <>
              <h3>Setup</h3>
              <p className="small muted">Get to where the change is, then walk the cases.</p>
              <ol className="setup">
                {review.setup.map((s, i) => {
                  const url = urlIn(s);
                  return (
                    <li key={i}>
                      {looksLikeCommand(s) ? <code>{s}</code> : <span>{s}</span>}
                      {looksLikeCommand(s) && (
                        <button className="btn ghost sm" onClick={() => navigator.clipboard?.writeText(s).then(() => ui.toast('Copied'))}>Copy</button>
                      )}
                      {url && <a className="btn ghost sm" href={url} target="_blank" rel="noreferrer">Open ↗</a>}
                    </li>
                  );
                })}
              </ol>
              {ticket && (ticket.worktree || ticket.preview) && (
                <div className="hpanel"><span className="small muted">Or skip the setup: run this branch on its own port and click through it.</span><PreviewControls t={ticket} compact /></div>
              )}
              {looseShots.length > 0 && (
                <div className="shots">{looseShots.map((a) => <a key={a.id} href={api.artifactUrl(ticket!.id, a.id)} target="_blank" rel="noreferrer"><img src={api.artifactUrl(ticket!.id, a.id)} alt={a.caption ?? a.name} /><span className="small muted">{a.caption ?? a.name}</span></a>)}</div>
              )}
              <button className="btn primary" onClick={() => go(0)}>Start case 1 →</button>
            </>
          )}

          {c && (
            <>
              <div className="small muted">Case {d.idx + 1} of {cases.length}</div>
              <h3>{c.title}</h3>
              <ol>{c.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
              <div className="expect"><span>You should see</span>{c.expect}</div>
              {ticket && shotsFor(d.idx).length > 0 && (
                <div className="shots big">
                  {shotsFor(d.idx).map((a) => (
                    <a key={a.id} href={api.artifactUrl(ticket.id, a.id)} target="_blank" rel="noreferrer" title="Open full size">
                      <img src={api.artifactUrl(ticket.id, a.id)} alt={a.caption ?? a.name} />
                    </a>
                  ))}
                </div>
              )}
              <textarea
                className="textarea"
                style={{ minHeight: 60 }}
                placeholder="Leave empty to approve, or describe what's wrong…"
                value={d.drafts[d.idx] ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setD((x) => {
                    const drafts = x.drafts.slice();
                    drafts[x.idx] = v;
                    return { ...x, drafts };
                  });
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) record(d.idx); }}
              />
              <div className="row">
                <button className="btn" onClick={() => go(d.idx - 1)}>←</button>
                {(d.drafts[d.idx] ?? '').trim()
                  ? <button className="btn primary" onClick={() => record(d.idx)}>Send feedback</button>
                  : <button className="btn ok" onClick={() => record(d.idx)}>✓ Approve</button>}
                <span className="small muted"><kbd>⌘</kbd> <kbd>↵</kbd></span>
              </div>
            </>
          )}

          {d.idx === cases.length && (
            <>
              <h3>Summary</h3>
              <p>
                <span style={{ color: 'var(--ok)' }}>✓ {summary.approved} approved</span> ·{' '}
                <span style={{ color: 'var(--warn)' }}>✎ {summary.feedback} with feedback</span>
                {summary.open > 0 && <> · <span className="muted">{summary.open} not checked yet</span></>}
              </p>
              {cases.map((cs, i) => d.verdicts[i]?.verdict === 'feedback' && (
                <div key={i} className="cmt minor"><strong>{i + 1}. {cs.title}:</strong> {d.verdicts[i]!.feedback}</div>
              ))}
              {d.notes.trim() && <div className="cmt"><strong>Notes:</strong> {d.notes}</div>}
              <div className="row">
                {summary.ship ? (
                  <button className="btn ok" disabled={busy} onClick={submit}>🚀 Approve & ship</button>
                ) : summary.feedback > 0 || d.notes.trim() ? (
                  <button className="btn primary" disabled={busy} onClick={submit}>↩ Send back with feedback</button>
                ) : (
                  <button className="btn" onClick={() => go(cases.findIndex((_, i) => !d.verdicts[i]))}>
                    Check the remaining {summary.open} case{summary.open === 1 ? '' : 's'} →
                  </button>
                )}
              </div>
            </>
          )}
        </section>

        <aside className="walk-notes">
          <label className="field">Notes
            <textarea className="textarea" style={{ minHeight: 140 }} placeholder="Anything that isn't about one case…" value={d.notes} onChange={(e) => setD((x) => ({ ...x, notes: e.target.value }))} />
          </label>
          <span className="small muted">Saved as you go — close and come back any time.</span>
        </aside>
      </div>
    </article>
  );
}
