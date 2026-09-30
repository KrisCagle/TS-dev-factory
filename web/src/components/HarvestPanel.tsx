import { useEffect, useState } from 'react';
import { api, type HarvestProject } from '../api';
import { fmtHours, useHarvest } from '../harvest';
import { useFactory } from '../state';
import { useUI } from '../ui';
import type { Ticket } from '../types';

let projectsCache: HarvestProject[] | null = null;

export function useHarvestProjects(enabled: boolean) {
  const [projects, setProjects] = useState<HarvestProject[] | null>(projectsCache);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      projectsCache = await api.harvestProjects();
      setProjects(projectsCache);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (enabled && !projectsCache) void load();
  }, [enabled]);
  return { projects, error, reload: load };
}

/** Per-ticket time: timer, quick log, and which Harvest project/task it bills to. */
export function HarvestPanel({ t }: { t: Ticket }) {
  const { settings } = useFactory();
  const hv = useHarvest();
  const ui = useUI();
  const [hours, setHours] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  const on = !!settings?.harvest.enabled;
  const { projects } = useHarvestProjects(on && edit);
  if (!on) return null;
  if (!hv.status?.configured) {
    return <div className="small muted">⏱ Harvest is on but not connected — add your token in Settings.</div>;
  }

  const timer = t.harvest?.timer;
  const projectId = t.harvest?.projectId ?? settings?.harvest.projectId;
  const taskId = t.harvest?.taskId ?? settings?.harvest.taskId;
  const proj = projectsCache?.find((p) => p.id === projectId);
  const task = proj?.tasks.find((x) => x.id === taskId);

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      ui.toast(msg);
      void hv.refresh(true);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const running = timer ? (Date.now() - timer.startedAt) / 3_600_000 : 0;

  return (
    <div className="hpanel">
      <div className="row wrap">
        <strong>⏱ Harvest</strong>
        <span className="small muted">
          {proj ? `${proj.client ? `${proj.client} · ` : ''}${proj.name}${task ? ` / ${task.name}` : ''}` : projectId ? `project #${projectId}` : 'no project set'}
          {t.harvest?.loggedHours ? ` · ${fmtHours(t.harvest.loggedHours)} logged` : ''}
        </span>
        <button className="btn ghost sm" onClick={() => setEdit((v) => !v)}>{edit ? 'Done' : 'Change'}</button>
        <span style={{ flex: 1 }} />
        {timer ? (
          <button className="btn danger sm" disabled={busy} onClick={() => act(() => api.timerStop(t.id), 'Timer stopped and logged')}>
            ■ Stop timer · {fmtHours(running)}
          </button>
        ) : (
          <button className="btn sm" disabled={busy} onClick={() => act(() => api.timerStart(t.id, 'PM work'), 'Timer started')}>▶ Start timer</button>
        )}
      </div>
      {edit && (
        <div className="grid2">
          <select className="select" value={projectId ?? ''} onChange={(e) => {
            const p = projects?.find((x) => x.id === Number(e.target.value));
            void api.updateTicket(t.id, { harvest: { loggedHours: 0, projectId: p?.id, taskId: p?.tasks[0]?.id } });
          }}>
            <option value="">{projects ? 'Default project' : 'Loading projects…'}</option>
            {projects?.map((p) => <option key={p.id} value={p.id}>{p.client ? `${p.client} — ` : ''}{p.name}</option>)}
          </select>
          <select className="select" value={taskId ?? ''} onChange={(e) => void api.updateTicket(t.id, { harvest: { loggedHours: 0, projectId, taskId: Number(e.target.value) } })}>
            {(projects?.find((p) => p.id === projectId)?.tasks ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </div>
      )}
      <div className="row">
        <input className="input" style={{ width: 90 }} placeholder="Hours" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
        <input className="input" placeholder={`Notes (default: ${t.key}: ${t.title.slice(0, 30)}…)`} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <button className="btn sm" disabled={busy || !(Number(hours) > 0)} onClick={() => act(() => api.logTime(t.id, Number(hours), notes), `Logged ${hours} h`).then(() => { setHours(''); setNotes(''); })}>Log</button>
      </div>
    </div>
  );
}
