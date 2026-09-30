import { useState } from 'react';
import { useFactory } from '../state';
import { useUI } from '../ui';
import type { LogKind } from '../types';

const KINDS: LogKind[] = ['status', 'text', 'tool', 'result', 'error', 'pm'];

export function Activity() {
  const { logs, tickets, agents } = useFactory();
  const ui = useUI();
  const [kinds, setKinds] = useState<Set<LogKind>>(new Set(['status', 'text', 'result', 'error', 'pm']));
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const color = (r?: string) => agents.find((a) => a.role === r)?.color ?? (r === 'pm' ? 'var(--accent)' : 'var(--muted)');
  const shown = logs.filter((l) => kinds.has(l.kind)).slice().reverse();

  return (
    <div className="activity">
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <span className="small muted">Show:</span>
        {KINDS.map((k) => (
          <label key={k} className="chip" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={kinds.has(k)} onChange={() => setKinds((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; })} /> {k}
          </label>
        ))}
      </div>
      <div className="card" style={{ padding: 8 }}>
        <div className="log">
          {shown.map((l) => (
            <div key={l.id} className={`ln ${l.kind}`} style={{ gridTemplateColumns: '70px 70px 76px 1fr', cursor: 'pointer' }} onClick={() => ui.openTicket(l.ticketId)}>
              <span className="ts">{new Date(l.ts).toLocaleTimeString()}</span>
              <span className="mono muted">{byId.get(l.ticketId)?.key ?? '—'}</span>
              <span className="who" style={{ color: color(l.agent) }}>{l.agent}</span>
              <span className="msg">{l.kind === 'tool' ? '↳ ' : ''}{l.text}</span>
            </div>
          ))}
          {!shown.length && <div className="empty">No activity yet.</div>}
        </div>
      </div>
    </div>
  );
}
