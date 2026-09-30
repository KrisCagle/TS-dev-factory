import { api } from '../api';
import { fmtHours, useHarvest } from '../harvest';
import { useFactory } from '../state';
import { useUI } from '../ui';

/** Top-bar Harvest status: today's total, and the running timer with a stop button. */
export function HarvestPill() {
  const { settings, tickets } = useFactory();
  const hv = useHarvest();
  const ui = useUI();
  if (!settings?.harvest.enabled || !hv.status?.configured) return null;
  const run = hv.status.running;
  const t = run?.ticketId ? tickets.find((x) => x.id === run.ticketId) : undefined;
  if (hv.status.error) return <span className="chip" title={hv.status.error}>⏱ Harvest error</span>;
  return (
    <span className="hpill">
      <span title="Logged in Harvest today">⏱ {fmtHours(hv.status.todayHours)}</span>
      {run && (
        <>
          <span className="rec" />
          <button
            className="linkish small"
            title={run.notes ?? ''}
            onClick={() => (t ? ui.openTicket(t.id) : undefined)}
          >
            {t ? t.key : (run.notes ?? 'Timer').slice(0, 24)}
          </button>
          {t && (
            <button className="btn ghost sm" title="Stop timer" onClick={() => api.timerStop(t.id).then(() => { ui.toast('Timer stopped and logged'); void hv.refresh(true); })}>■</button>
          )}
        </>
      )}
    </span>
  );
}
