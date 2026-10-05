import { useState } from 'react';
import { api } from '../api';
import { Toggle } from '../components/Bits';
import { useHarvestProjects } from '../components/HarvestPanel';
import { useHarvest } from '../harvest';
import { useUI } from '../ui';
import type { NotifyEvent, Project, Settings as S } from '../types';

const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#8b5cf6'];

function newProject(existing: Project[]): Project {
  const n = existing.length + 1;
  return {
    id: `p${Date.now().toString(36)}`,
    name: `Project ${n}`,
    keyPrefix: `P${n}`,
    color: COLORS[existing.length % COLORS.length],
    repoPath: '',
    baseBranch: 'main',
    worktreesDir: '',
    mergeStrategy: 'pull-request',
    previewCommand: 'npm run dev -- --port $PORT',
    previewPath: '/',
  };
}

/** One card per repo / client. Each gets its own board filter, ticket prefix, shipping and Harvest project. */
export function ProjectsSettings({ s, setS }: { s: S; setS: (s: S) => void }) {
  const hv = useHarvest();
  const harvestOn = s.harvest.enabled && !!hv.status?.configured && !hv.status.error;
  const { projects: hvProjects } = useHarvestProjects(harvestOn);
  const [openId, setOpenId] = useState<string | null>(s.projects.length === 1 ? s.projects[0].id : null);

  const upd = (id: string, patch: Partial<Project>) => setS({ ...s, projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  const add = () => {
    const p = newProject(s.projects);
    setS({ ...s, projects: [...s.projects, p] });
    setOpenId(p.id);
  };
  const remove = (p: Project) => {
    if (s.projects.length < 2) return;
    if (!confirm(`Remove “${p.name}”? Its tickets move to the default project.`)) return;
    setS({ ...s, projects: s.projects.filter((x) => x.id !== p.id) });
  };

  return (
    <section className="card">
      <h2>📁 Projects</h2>
      <div className="desc">One per repo or client. Each has its own ticket prefix, shipping rules, live preview and Harvest project. Switch between them from the top bar.</div>
      {s.projects.map((p) => {
        const open = openId === p.id;
        const hvp = hvProjects?.find((x) => x.id === p.harvestProjectId);
        return (
          <div key={p.id} className="proj">
            <div className="row">
              <span className="pdot" style={{ background: p.color }} />
              <strong>{p.name}</strong>
              <span className="chip mono">{p.keyPrefix}-…</span>
              {s.defaultProjectId === p.id && <span className="chip">default</span>}
              <span className="small muted mono ellipsis">{p.repoPath || 'no repo yet'}</span>
              <span className="grow" />
              <button className="btn ghost sm" onClick={() => setOpenId(open ? null : p.id)}>{open ? 'Close' : 'Edit'}</button>
            </div>
            {open && (
              <>
                <div className="grid2">
                  <label className="field">Name<input className="input" value={p.name} onChange={(e) => upd(p.id, { name: e.target.value })} /></label>
                  <label className="field">Ticket prefix
                    <input className="input mono" value={p.keyPrefix} maxLength={8} onChange={(e) => upd(p.id, { keyPrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
                  </label>
                  <label className="field">Repository path (git)
                    <input className="input mono" placeholder="/Users/you/code/my-app" value={p.repoPath} onChange={(e) => upd(p.id, { repoPath: e.target.value })} />
                  </label>
                  <label className="field">Base branch<input className="input mono" value={p.baseBranch} onChange={(e) => upd(p.id, { baseBranch: e.target.value })} /></label>
                  <label className="field">Worktrees folder (optional)
                    <input className="input mono" placeholder="defaults to <repo>-factory-worktrees" value={p.worktreesDir} onChange={(e) => upd(p.id, { worktreesDir: e.target.value })} />
                  </label>
                  <label className="field">When you approve
                    <select className="select" value={p.mergeStrategy} onChange={(e) => upd(p.id, { mergeStrategy: e.target.value as Project['mergeStrategy'] })}>
                      <option value="local-merge">Merge into base branch locally</option>
                      <option value="pull-request">Push branch & open a GitHub PR</option>
                      <option value="none">Leave the branch for me</option>
                    </select>
                  </label>
                  <label className="field">GitHub repo for PRs (optional)
                    <input className="input mono" placeholder={s.connectors.github.repo || 'owner/repo'} value={p.githubRepo ?? ''} onChange={(e) => upd(p.id, { githubRepo: e.target.value || undefined })} />
                  </label>
                  <label className="field">Colour
                    <div className="swatches">{COLORS.map((c) => <span key={c} className={`swatch ${p.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => upd(p.id, { color: c })} />)}</div>
                  </label>
                  <label className="field">Live preview command
                    <input className="input mono" placeholder="npm run dev -- --port $PORT" value={p.previewCommand ?? ''} onChange={(e) => upd(p.id, { previewCommand: e.target.value })} />
                  </label>
                  <label className="field">Open preview at path
                    <input className="input mono" placeholder="/" value={p.previewPath ?? ''} onChange={(e) => upd(p.id, { previewPath: e.target.value })} />
                  </label>
                  <label className="field">Smoke command (after shipping)
                    <input className="input mono" placeholder="npm test" value={p.smokeCommand ?? ''} onChange={(e) => upd(p.id, { smokeCommand: e.target.value || undefined })} />
                  </label>
                  <label className="field">Sensitive paths (lower the safety score)
                    <input className="input mono" placeholder="migrations/, auth, payment, .env" value={(p.riskyPaths ?? []).join(', ')} onChange={(e) => upd(p.id, { riskyPaths: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
                  </label>
                  {harvestOn && (
                    <>
                      <label className="field">Harvest project
                        <select className="select" value={p.harvestProjectId ?? ''} onChange={(e) => {
                          const h = hvProjects?.find((x) => x.id === Number(e.target.value));
                          upd(p.id, { harvestProjectId: h?.id, harvestTaskId: h?.tasks[0]?.id });
                        }}>
                          <option value="">Use the Harvest default</option>
                          {hvProjects?.map((h) => <option key={h.id} value={h.id}>{h.client ? `${h.client} — ` : ''}{h.name}</option>)}
                        </select>
                      </label>
                      <label className="field">Harvest task
                        <select className="select" value={p.harvestTaskId ?? ''} onChange={(e) => upd(p.id, { harvestTaskId: Number(e.target.value) || undefined })}>
                          {(hvp?.tasks ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      </label>
                    </>
                  )}
                </div>
                <div className="small muted">The preview command runs inside the ticket’s own copy of the repo. <code>$PORT</code> is replaced with a free port.</div>
                <div className="row">
                  {s.defaultProjectId !== p.id && <button className="btn sm" onClick={() => setS({ ...s, defaultProjectId: p.id })}>Make default</button>}
                  <span className="grow" />
                  {s.projects.length > 1 && <button className="btn ghost sm" style={{ color: 'var(--bad)' }} onClick={() => remove(p)}>Remove project</button>}
                </div>
              </>
            )}
          </div>
        );
      })}
      <div><button className="btn sm" onClick={add}>＋ Add project</button></div>
    </section>
  );
}

const EVENTS: Array<{ k: NotifyEvent; label: string }> = [
  { k: 'needsYou', label: 'Something needs me (sign-off, plan, question)' },
  { k: 'ciFailed', label: 'CI failed on a ticket' },
  { k: 'stuck', label: 'An agent is stuck and nudging didn’t help' },
  { k: 'failed', label: 'A ticket failed' },
  { k: 'shipped', label: 'A ticket shipped' },
];

export function NotificationSettingsCard({ s, setS, dirty }: { s: S; setS: (s: S) => void; dirty: boolean }) {
  const ui = useUI();
  const n = s.notifications;
  const set = (patch: Partial<S['notifications']>) => setS({ ...s, notifications: { ...n, ...patch } });
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

  const askPermission = async () => {
    if (typeof Notification === 'undefined') return;
    setPerm(await Notification.requestPermission());
  };
  const test = async () => {
    try {
      if (dirty) await api.updateSettings(s);
      await api.testNotification();
      ui.toast('Test notification sent');
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };

  return (
    <section className="card">
      <h2>🔔 Notifications</h2>
      <div className="desc">Get pinged when the factory needs you, so you can work on something else in the meantime.</div>
      <div className="row"><Toggle on={n.enabled} onChange={(v) => set({ enabled: v })} /> <span><strong>Notifications on</strong></span><span className="grow" />{n.enabled && <button className="btn sm" onClick={test}>Send a test</button>}</div>
      {n.enabled && (
        <>
          <div className="field">Where
            <div className="row"><Toggle on={n.macos} onChange={(v) => set({ macos: v })} /> <span>Mac notification centre <span className="muted small">(from the factory server)</span></span></div>
            <div className="row">
              <Toggle on={n.browser} onChange={(v) => set({ browser: v })} /> <span>Browser, when the factory tab is in the background</span>
              {n.browser && perm !== 'granted' && perm !== 'unsupported' && <button className="btn sm" onClick={askPermission}>{perm === 'denied' ? 'Blocked — allow in browser settings' : 'Allow browser notifications'}</button>}
            </div>
            <div className="row"><Toggle on={n.slack.enabled} onChange={(v) => set({ slack: { ...n.slack, enabled: v } })} /> <span>Slack</span></div>
            {n.slack.enabled && (
              <label className="field">Slack incoming webhook URL
                <input className="input mono" type="password" placeholder="https://hooks.slack.com/services/…" value={n.slack.webhookUrl} onChange={(e) => set({ slack: { ...n.slack, webhookUrl: e.target.value } })} />
              </label>
            )}
          </div>
          <div className="field">Tell me when
            <div className="checks col">
              {EVENTS.map((e) => (
                <label key={e.k}><input type="checkbox" checked={n.events[e.k]} onChange={(x) => set({ events: { ...n.events, [e.k]: x.target.checked } })} /> {e.label}</label>
              ))}
            </div>
          </div>
          <div className="row wrap">
            <Toggle on={n.quietHours.enabled} onChange={(v) => set({ quietHours: { ...n.quietHours, enabled: v } })} /> <span>Quiet hours</span>
            {n.quietHours.enabled && (
              <>
                <input className="input" type="time" style={{ width: 120 }} value={n.quietHours.from} onChange={(e) => set({ quietHours: { ...n.quietHours, from: e.target.value } })} />
                <span>to</span>
                <input className="input" type="time" style={{ width: 120 }} value={n.quietHours.to} onChange={(e) => set({ quietHours: { ...n.quietHours, to: e.target.value } })} />
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
