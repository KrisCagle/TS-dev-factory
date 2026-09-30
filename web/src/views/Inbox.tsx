import { useState } from 'react';
import { DecisionCard } from '../components/Attention';
import { ago } from '../meta';
import { useFactory } from '../state';
import { useUI } from '../ui';
import type { AttentionItem } from '../types';

type Filter = 'all' | AttentionItem['kind'];

export function Inbox() {
  const { attention, needsYou, tickets } = useFactory();
  const ui = useUI();
  const [filter, setFilter] = useState<Filter>('all');
  const [showDone, setShowDone] = useState(false);

  const held = attention.filter((a) => a.status === 'held');
  const shown = needsYou.filter((a) => filter === 'all' || a.kind === filter);
  const resolved = attention
    .filter((a) => a.status === 'resolved')
    .sort((a, b) => (b.resolution?.at ?? b.updatedAt) - (a.resolution?.at ?? a.updatedAt))
    .slice(0, 25);
  const count = (k: Filter) => (k === 'all' ? needsYou.length : needsYou.filter((a) => a.kind === k).length);
  const keyOf = (id?: string) => tickets.find((t) => t.id === id)?.key ?? '';

  return (
    <div className="inbox">
      <div className="row wrap" style={{ marginBottom: 14 }}>
        <div className="seg">
          {(['all', 'review', 'decision', 'error'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {{ all: 'All', review: 'Reviews', decision: 'Decisions', error: 'Errors', todo: 'To-dos' }[f]} {count(f) > 0 && `(${count(f)})`}
            </button>
          ))}
        </div>
        <span className="small muted">Everything the agents need from you, most urgent first. Each item says what we recommend and what happens if it waits.</span>
      </div>

      {shown.length === 0 ? (
        <div className="empty card" style={{ padding: 32 }}>
          <div style={{ fontSize: 28 }}>🎉</div>
          <strong>Nothing needs you{filter !== 'all' ? ' in this filter' : ''}.</strong>
          <div className="small">The agents will post here when they need a decision or a sign-off.</div>
        </div>
      ) : (
        <div className="alist">{shown.map((a) => <DecisionCard key={a.id} item={a} />)}</div>
      )}

      {held.length > 0 && (
        <section style={{ marginTop: 22 }}>
          <h2 className="sect">⏳ On hold <span className="muted small">— released to you automatically</span></h2>
          <div className="alist compact">
            {held.map((a) => (
              <div key={a.id} className="hrow" onClick={() => a.ticketId && ui.openTicket(a.ticketId)}>
                <span className="mono small">{keyOf(a.ticketId)}</span>
                <span>{a.title}</span>
                <span className="chip">{a.heldReason}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section style={{ marginTop: 22 }}>
        <button className="btn ghost sm" onClick={() => setShowDone((v) => !v)}>{showDone ? '▾' : '▸'} Recently answered ({resolved.length})</button>
        {showDone && (
          <div className="alist compact" style={{ marginTop: 8 }}>
            {resolved.map((a) => (
              <div key={a.id} className="hrow" onClick={() => a.ticketId && ui.openTicket(a.ticketId)}>
                <span className="mono small">{keyOf(a.ticketId)}</span>
                <span>{a.title}</span>
                <span className="chip">{describe(a)}</span>
                <span className="small muted">{ago(a.resolution?.at ?? a.updatedAt)} ago</span>
              </div>
            ))}
            {!resolved.length && <div className="small muted">Nothing yet.</div>}
          </div>
        )}
      </section>
    </div>
  );
}

function describe(a: AttentionItem) {
  const r = a.resolution;
  if (!r) return 'answered';
  const label = a.options?.find((o) => o.id === r.option)?.label;
  if (r.verdicts) {
    const fb = r.verdicts.filter((v) => v.verdict === 'feedback').length;
    return fb || r.notes ? `sent back · ${fb} case${fb === 1 ? '' : 's'} with feedback` : `approved · ${r.verdicts.length} cases`;
  }
  return label ?? r.option ?? 'answered';
}
