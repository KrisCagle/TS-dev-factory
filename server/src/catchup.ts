import type { Store } from './store.js';

export interface CatchUp {
  since: number;
  awayMs: number;
  headline: string;
  shipped: Array<{ id: string; key: string; title: string }>;
  needsYou: Array<{ id: string; ticketId?: string; title: string; isNew: boolean }>;
  problems: Array<{ id: string; key: string; title: string; what: string }>;
  started: Array<{ id: string; key: string; title: string; stage: string }>;
  spendUsd: number;
  quiet: boolean;
}

/** "While you were away": what happened since a moment, in one glance. */
export function catchUp(store: Store, since: number, projectId?: string, now = Date.now()): CatchUp {
  const tickets = store.tickets().filter((t) => !projectId || t.projectId === projectId);
  const ids = new Set(tickets.map((t) => t.id));
  const shipped = tickets.filter((t) => t.stage === 'done' && (t.finishedAt ?? 0) >= since);
  const open = store.attention().filter((a) => a.status === 'open' && (!projectId || (a.ticketId && ids.has(a.ticketId))));
  const logs = store.logs(undefined, 5000).filter((l) => l.ts >= since && ids.has(l.ticketId));
  const problems = tickets
    .filter((t) => (t.stage === 'failed' && t.updatedAt >= since) || (t.ship?.smoke?.state === 'failed' && t.ship.smoke.at >= since && !t.ship.reverted) || (t.ship?.reverted && t.ship.reverted.at >= since))
    .map((t) => ({ id: t.id, key: t.key, title: t.title, what: t.ship?.reverted ? 'reverted' : t.ship?.smoke?.state === 'failed' ? 'smoke test failed after shipping' : t.error?.slice(0, 120) ?? 'failed' }));
  const startedIds = new Set(logs.filter((l) => /started$/.test(l.text) && l.agent === 'planner').map((l) => l.ticketId));
  const started = tickets.filter((t) => startedIds.has(t.id)).map((t) => ({ id: t.id, key: t.key, title: t.title, stage: t.stage }));
  const spendUsd = +logs.reduce((a, l) => a + Number(l.text.match(/finished \(\$([\d.]+)\)/)?.[1] ?? 0), 0).toFixed(2);
  const needsYou = open.map((a) => ({ id: a.id, ticketId: a.ticketId, title: a.title, isNew: a.createdAt >= since }));

  const bits: string[] = [];
  if (shipped.length) bits.push(`${shipped.length} shipped`);
  const fresh = needsYou.filter((n) => n.isNew).length;
  if (needsYou.length) bits.push(`${needsYou.length} waiting on you${fresh && fresh !== needsYou.length ? ` (${fresh} new)` : ''}`);
  if (problems.length) bits.push(`${problems.length} need${problems.length === 1 ? 's' : ''} attention`);
  if (started.length) bits.push(`${started.length} started`);
  const quiet = !bits.length;
  return {
    since,
    awayMs: now - since,
    headline: quiet ? 'All quiet — nothing changed while you were away.' : `${bits.join(' · ')}${spendUsd ? ` · $${spendUsd.toFixed(2)} spent` : ''}`,
    shipped: shipped.map((t) => ({ id: t.id, key: t.key, title: t.title })),
    needsYou,
    problems,
    started,
    spendUsd,
    quiet,
  };
}
