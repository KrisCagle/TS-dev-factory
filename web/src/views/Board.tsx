import { useMemo, useState } from 'react';
import { api } from '../api';
import { TicketCard } from '../components/Bits';
import { PRIORITY_META, SOURCE_META, STAGE_META } from '../meta';
import { usePrefs } from '../prefs';
import { useFactory } from '../state';
import { useUI } from '../ui';
import type { Stage, Ticket } from '../types';

const DROPPABLE: Stage[] = ['backlog', 'ready'];
const DRAGGABLE_FROM: Stage[] = ['backlog', 'ready', 'failed', 'done'];

export function Board({ filter }: { filter: string }) {
  const { tickets } = useFactory();
  const { prefs } = usePrefs();
  const ui = useUI();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<Stage | null>(null);

  const visible = useMemo(() => {
    const q = filter.toLowerCase().trim();
    return tickets.filter((t) => !q || `${t.key} ${t.title} ${t.labels.join(' ')} ${t.description}`.toLowerCase().includes(q));
  }, [tickets, filter]);

  const byStage = (s: Stage) =>
    visible
      .filter((t) => t.stage === s)
      .sort((a, b) =>
        s === 'done' ? (b.finishedAt ?? 0) - (a.finishedAt ?? 0) : PRIORITY_META[a.priority].rank - PRIORITY_META[b.priority].rank || a.order - b.order,
      );

  const drop = async (stage: Stage) => {
    const t = tickets.find((x) => x.id === drag);
    setDrag(null);
    setOver(null);
    if (!t || t.stage === stage) return;
    try {
      await api.updateTicket(t.id, { stage });
      if (stage === 'ready') ui.toast(`${t.key} sent to the factory`);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };

  const groups = (ts: Ticket[]): Array<[string, Ticket[]]> => {
    if (prefs.groupBy === 'none') return [['', ts]];
    const key = (t: Ticket) => (prefs.groupBy === 'priority' ? PRIORITY_META[t.priority].label : SOURCE_META[t.source].label);
    const m = new Map<string, Ticket[]>();
    ts.forEach((t) => m.set(key(t), [...(m.get(key(t)) ?? []), t]));
    return [...m.entries()];
  };

  return (
    <div className="board">
      {prefs.columns.map((stage) => {
        const ts = byStage(stage);
        const canDrop = drag && DROPPABLE.includes(stage);
        return (
          <section
            key={stage}
            className={`col ${over === stage && canDrop ? 'drop' : ''}`}
            onDragOver={(e) => { if (canDrop) { e.preventDefault(); setOver(stage); } }}
            onDragLeave={() => setOver(null)}
            onDrop={() => drop(stage)}
          >
            <header className="col-h" title={STAGE_META[stage].hint}>
              <span>{STAGE_META[stage].icon}</span>
              <span>{STAGE_META[stage].label}</span>
              <span className="n">{ts.length}</span>
              {(stage === 'backlog' || stage === 'ready') && (
                <button className="btn ghost sm add" onClick={() => ui.newTicket(stage)} title="New ticket">＋</button>
              )}
            </header>
            <div className="col-body">
              {groups(ts).map(([g, items]) => (
                <div key={g} style={{ display: 'contents' }}>
                  {g && <div className="group-h">{g}</div>}
                  {items.map((t) => (
                    <TicketCard
                      key={t.id}
                      t={t}
                      dragging={drag === t.id}
                      draggable={DRAGGABLE_FROM.includes(t.stage)}
                      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDrag(t.id); }}
                      onDragEnd={() => { setDrag(null); setOver(null); }}
                    />
                  ))}
                </div>
              ))}
              {!ts.length && <div className="small muted" style={{ padding: '6px 4px' }}>{stage === 'ready' ? 'Drag tickets here to hand them to the agents.' : '—'}</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
