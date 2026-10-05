import { SafetyBadge } from './Quality';
import { useFactory } from '../state';
import { usePrefs } from '../prefs';
import { compact, duration, money, PRIORITY_META, ROLE_META, SOURCE_META, ago } from '../meta';
import type { AgentRole, Ticket } from '../types';
import { useUI } from '../ui';
import { ACTIVE_STAGES } from '../meta';
import { fmtHours, useHarvest } from '../harvest';

export function Toggle({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return <button type="button" title={title} className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} aria-pressed={on} />;
}

export function AgentPill({ role, live }: { role: AgentRole; live?: boolean }) {
  const { agents } = useFactory();
  const a = agents.find((x) => x.role === role);
  return (
    <span className="agent-pill" style={{ background: a?.color ?? '#64748b' }}>
      {live ? <span className="spin" /> : ROLE_META[role].icon} {a?.name ?? role}
    </span>
  );
}

export function PriorityDot({ p }: { p: Ticket['priority'] }) {
  return <span className="dot" title={PRIORITY_META[p].label} style={{ background: PRIORITY_META[p].color }} />;
}

export function TicketCard({ t, draggable, onDragStart, onDragEnd, dragging }: {
  t: Ticket; draggable?: boolean; dragging?: boolean; onDragStart?: (e: React.DragEvent) => void; onDragEnd?: () => void;
}) {
  const { prefs } = usePrefs();
  const { agents } = useFactory();
  const ui = useUI();
  const live = ACTIVE_STAGES.includes(t.stage) && t.activeAgent;
  const agentColor = agents.find((a) => a.role === t.activeAgent)?.color;
  const f = prefs.cardFields;
  return (
    <div
      className={`tcard ${live ? 'live' : ''} ${dragging ? 'dragging' : ''}`}
      style={{ ['--agent' as string]: agentColor }}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => ui.openTicket(t.id)}
    >
      <span className="pri" style={{ background: PRIORITY_META[t.priority].color }} />
      <div className="row">
        <span className="k">{t.key}</span>
        <ProjectTag projectId={t.projectId} />
        {f.source && t.source !== 'local' && <span className="chip">{SOURCE_META[t.source].icon} {SOURCE_META[t.source].label}</span>}
        <span style={{ marginLeft: 'auto' }} />
        {t.iterations > 0 && <span className="chip" title="Rework loops">🔁 {t.iterations}</span>}
      </div>
      <div className="t">{t.title}</div>
      {f.labels && t.labels.length > 0 && (
        <div className="meta">{t.labels.slice(0, 4).map((l) => <span key={l} className="chip">{l}</span>)}</div>
      )}
      <div className="meta">
        {f.agent && t.activeAgent && live && <AgentPill role={t.activeAgent} live />}
        {t.stage === 'awaiting_approval' && <span className="badge" style={{ background: 'var(--accent)', color: 'white' }}>{t.gate === 'plan' ? 'Approve plan' : 'Sign off'}</span>}
        {t.stage === 'ci' && <span className={`chip ci-${t.ci?.state ?? 'pending'}`}>🚦 {t.prNumber ? `#${t.prNumber} ` : ''}{t.ci?.checks.filter((c) => c.state === 'success').length ?? 0}/{t.ci?.checks.length || '…'} checks</span>}
        {t.harvest?.timer && <span className="chip ci-pending" title="Harvest timer running">⏱</span>}
        {t.stage === 'failed' && <span className="badge" style={{ color: 'var(--bad)' }}>⚠ {t.error?.slice(0, 40)}</span>}
        {t.stage === 'done' && t.prUrl && <span className="chip">PR opened</span>}
        {(t.stage === 'awaiting_approval' || t.stage === 'ci') && t.gate !== 'plan' && <SafetyBadge c={t.confidence} compact />}
        {t.ship?.smoke?.state === 'failed' && !t.ship.reverted && <span className="chip" style={{ color: 'var(--bad)' }}>🧯 smoke failed</span>}
        {t.ship?.reverted && <span className="chip" style={{ color: 'var(--warn)' }}>↩ reverted</span>}
        <span style={{ marginLeft: 'auto' }} />
        {f.cost && t.costUsd > 0 && <span title={`${compact(t.tokens)} tokens`}>{money(t.costUsd)}</span>}
        {f.age && <span>{ago(t.createdAt)}</span>}
      </div>
    </div>
  );
}

export function Widgets() {
  const { tickets, needsYou, stats } = useFactory();
  const { prefs } = usePrefs();
  const hv = useHarvest();
  if (!stats) return null;
  // computed from the visible tickets, so the numbers follow the project switcher
  const done = tickets.filter((t) => t.stage === 'done');
  const cycles = done.filter((t) => t.startedAt && t.finishedAt).map((t) => t.finishedAt! - t.startedAt!);
  const inFlight = tickets.filter((t) => ACTIVE_STAGES.includes(t.stage)).length;
  const inCi = tickets.filter((t) => t.stage === 'ci').length;
  const reviewed = tickets.filter((t) => t.review);
  const cost = tickets.reduce((a, t) => a + t.costUsd, 0);
  const tokens = tickets.reduce((a, t) => a + t.tokens, 0);
  const w = prefs.widgets;
  const items: Array<[boolean, string, string, boolean?]> = [
    [w.throughput, `${done.length}`, 'Shipped'],
    [w.inFlight, `${inFlight}${inCi ? ` +${inCi}` : ''}`, inCi ? 'Working · in CI' : 'Agents working'],
    [w.awaiting, `${needsYou.length}`, 'Waiting on you', needsYou.length > 0],
    [w.cost, money(cost), `Spend · ${compact(tokens)} tok`],
    [w.cycle, duration(cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : 0), 'Avg cycle time'],
    [w.loops, `${reviewed.length ? Math.round((reviewed.filter((t) => t.iterations > 0).length / reviewed.length) * 100) : 0}%`, 'Needed rework'],
    [!!(w.harvest && hv.status?.configured), fmtHours(hv.status?.todayHours ?? 0), 'Harvest today'],
  ];
  const shown = items.filter((i) => i[0]);
  if (!shown.length) return null;
  return (
    <div className="widgets">
      {shown.map(([, v, l, hot]) => (
        <div key={l} className={`widget ${hot ? 'hot' : ''}`}>
          <div className="v">{v}</div>
          <div className="l">{l}</div>
        </div>
      ))}
    </div>
  );
}

/** Top-bar project switcher. */
export function ProjectSwitcher() {
  const { projects, allTickets } = useFactory();
  const { prefs, set } = usePrefs();
  if (projects.length < 2) return null;
  const color = projects.find((p) => p.id === prefs.activeProject)?.color;
  return (
    <label className="pswitch" title="Switch project">
      <span className="dot" style={{ background: color ?? 'var(--faint)' }} />
      <select value={prefs.activeProject} onChange={(e) => set({ activeProject: e.target.value })}>
        <option value="all">All projects ({allTickets.length})</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name} ({allTickets.filter((t) => t.projectId === p.id).length})</option>
        ))}
      </select>
    </label>
  );
}

/** Small project tag for cards when viewing all projects. */
export function ProjectTag({ projectId }: { projectId: string }) {
  const { projects, project } = useFactory();
  if (project || projects.length < 2) return null;
  const p = projects.find((x) => x.id === projectId);
  if (!p) return null;
  return <span className="chip" style={{ borderColor: p.color, color: p.color }}>{p.name}</span>;
}
