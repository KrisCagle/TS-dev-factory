import { useEffect, useState } from 'react';
import { api } from '../api';
import { Toggle } from '../components/Bits';
import { STAGE_META } from '../meta';
import { ALL_COLUMNS, usePrefs, type Prefs, type View } from '../prefs';
import { useFactory } from '../state';
import { useHarvestProjects } from '../components/HarvestPanel';
import { useHarvest } from '../harvest';
import { useUI } from '../ui';
import type { Settings as S, TicketSource } from '../types';
import { NotificationSettingsCard, ProjectsSettings } from './SettingsExtra';
import { ClaudeCard, PluginsCard, SlackAppCard } from './SettingsIntegrations';

const ACCENTS = ['#6366f1', '#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6'];

export function Settings() {
  const { settings, hasApiKey } = useFactory();
  const { prefs, set, reset } = usePrefs();
  const ui = useUI();
  const [s, setS] = useState<S | null>(settings);
  useEffect(() => setS(settings), [settings]);
  if (!s) return null;

  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const save = async () => {
    try {
      await api.updateSettings(s);
      ui.toast('Settings saved');
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };
  const conn = <K extends keyof S['connectors']>(k: K, patch: Partial<S['connectors'][K]>) =>
    setS({ ...s, connectors: { ...s.connectors, [k]: { ...s.connectors[k], ...patch } } });
  const test = async (src: TicketSource) => {
    try {
      if (dirty) await api.updateSettings(s);
      ui.toast(`✓ ${(await api.testConnector(src)).message}`);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };
  const sync = async (src: TicketSource) => {
    try {
      if (dirty) await api.updateSettings(s);
      const r = await api.sync(src);
      ui.toast(`Imported ${r.created} new of ${r.fetched} tickets into Backlog`);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };

  const setPref = <K extends keyof Prefs>(k: K, v: Prefs[K]) => set({ [k]: v } as Partial<Prefs>);

  return (
    <div className="settings">
      {dirty && (
        <div className="card" style={{ position: 'sticky', top: 0, zIndex: 3, padding: '10px 14px', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <span>Unsaved factory settings</span><span style={{ flex: 1 }} />
          <button className="btn" onClick={() => setS(settings)}>Discard</button>
          <button className="btn primary" onClick={save}>Save</button>
        </div>
      )}

      <section className="card">
        <h2>🏭 Factory</h2>
        <div className="desc">How agents run. Repos, branches and shipping are set per project below.</div>
        <div className="row">
          <div className="seg">
            <button className={s.mode === 'mock' ? 'on' : ''} onClick={() => setS({ ...s, mode: 'mock' })}>Simulated agents</button>
            <button className={s.mode === 'live' ? 'on' : ''} onClick={() => setS({ ...s, mode: 'live' })}>Live (Claude Agent SDK)</button>
          </div>
          {s.mode === 'live' && !hasApiKey && <span className="small" style={{ color: 'var(--warn)' }}>No ANTHROPIC_API_KEY on the server — live mode will use your Claude Code login if present.</span>}
        </div>
        <div className="grid2">
          <label className="field">Tickets worked in parallel
            <input className="input" type="number" min={1} max={8} value={s.concurrency} onChange={(e) => setS({ ...s, concurrency: Number(e.target.value) })} />
          </label>
          <label className="field">Rework loops before escalating to you
            <input className="input" type="number" min={1} max={10} value={s.maxLoops} onChange={(e) => setS({ ...s, maxLoops: Number(e.target.value) })} />
          </label>
          <label className="field">Budget per ticket (USD, 0 = none)
            <input className="input" type="number" min={0} step={0.5} value={s.budgetPerTicketUsd} onChange={(e) => setS({ ...s, budgetPerTicketUsd: Number(e.target.value) })} />
          </label>
        </div>
        <div className="grid2">
          <label className="field">Ask me before work forecast over (USD, 0 = never)
            <input className="input" type="number" min={0} step={0.5} value={s.forecast.approveAboveUsd} onChange={(e) => setS({ ...s, forecast: { ...s.forecast, approveAboveUsd: Number(e.target.value) } })} />
          </label>
          <div className="small muted" style={{ alignSelf: 'end' }}>The Planner forecasts cost and time for every ticket. Forecasts adjust to how past tickets on each project actually went.</div>
        </div>
        <div className="row"><Toggle on={s.gates.plan} onChange={(v) => setS({ ...s, gates: { ...s.gates, plan: v } })} /> <span>Approve every plan before coding starts</span></div>
        <div className="row"><Toggle on={s.gates.merge} onChange={(v) => setS({ ...s, gates: { ...s.gates, merge: v } })} /> <span>Sign off before anything merges or opens a PR</span></div>
      </section>

      <ProjectsSettings s={s} setS={setS} />

      <section className="card">
        <h2>🛡 Quality gates</h2>
        <div className="desc">Checks between the agents and you, so you only see work that's ready.</div>
        <div className="row"><Toggle on={s.ciGate.enabled} onChange={(v) => setS({ ...s, ciGate: { ...s.ciGate, enabled: v } })} /> <span><strong>CI gate</strong> — open the PR first, hold your sign-off until checks are green, and send red CI back to the Coder instead of to you</span></div>
        {s.ciGate.enabled && (
          <div className="grid2">
            <label className="field">Poll CI every (seconds)
              <input className="input" type="number" min={10} value={s.ciGate.pollSeconds} onChange={(e) => setS({ ...s, ciGate: { ...s.ciGate, pollSeconds: Number(e.target.value) } })} />
            </label>
            <label className="field">Ask me if CI runs longer than (minutes)
              <input className="input" type="number" min={5} value={s.ciGate.maxWaitMinutes} onChange={(e) => setS({ ...s, ciGate: { ...s.ciGate, maxWaitMinutes: Number(e.target.value) } })} />
            </label>
            <label className="field">Merge the PR with
              <select className="select" value={s.ciGate.mergeMethod} onChange={(e) => setS({ ...s, ciGate: { ...s.ciGate, mergeMethod: e.target.value as S['ciGate']['mergeMethod'] } })}>
                <option value="squash">Squash</option><option value="merge">Merge commit</option><option value="rebase">Rebase</option>
              </select>
            </label>
            <div className="small muted" style={{ alignSelf: 'end' }}>Live mode uses it for projects whose “When you approve” is <em>open a GitHub PR</em>, with GitHub connected. Simulated mode fakes CI so you can try it.</div>
          </div>
        )}
        <div className="row"><Toggle on={s.quality.coverage.enabled} onChange={(v) => setS({ ...s, quality: { ...s.quality, coverage: { ...s.quality.coverage, enabled: v } } })} /> <span><strong>Coverage gate</strong> — send the change back when test coverage drops (projects that can measure it)</span></div>
        {s.quality.coverage.enabled && (
          <div className="grid2">
            <label className="field">Allowed drop (percentage points)
              <input className="input" type="number" min={0} step={0.1} value={s.quality.coverage.maxDropPct} onChange={(e) => setS({ ...s, quality: { ...s.quality, coverage: { ...s.quality.coverage, maxDropPct: Number(e.target.value) } } })} />
            </label>
          </div>
        )}
        <div className="row"><Toggle on={s.quality.requireProof} onChange={(v) => setS({ ...s, quality: { ...s.quality, requireProof: v } })} /> <span><strong>Require proof</strong> — send the change back if any acceptance criterion has no test proving it (off: it's flagged in your review instead)</span></div>
        <div className="row"><Toggle on={s.quality.smoke} onChange={(v) => setS({ ...s, quality: { ...s.quality, smoke: v } })} /> <span><strong>Smoke test after shipping</strong> — run each project's smoke command on the base branch, and offer a one-click revert if it fails</span></div>
        <div className="row"><Toggle on={s.watchdog.enabled} onChange={(v) => setS({ ...s, watchdog: { ...s.watchdog, enabled: v } })} /> <span><strong>Watchdog</strong> — restart an agent that goes quiet with a nudge, and only bring it to you if that doesn't work</span></div>
        {s.watchdog.enabled && (
          <div className="grid2">
            <label className="field">Nudge after no activity for (minutes)
              <input className="input" type="number" min={1} value={s.watchdog.stallMinutes} onChange={(e) => setS({ ...s, watchdog: { ...s.watchdog, stallMinutes: Number(e.target.value) } })} />
            </label>
            <label className="field">Nudges before asking you
              <input className="input" type="number" min={0} max={5} value={s.watchdog.maxNudges} onChange={(e) => setS({ ...s, watchdog: { ...s.watchdog, maxNudges: Number(e.target.value) } })} />
            </label>
          </div>
        )}
      </section>

      <NotificationSettingsCard s={s} setS={setS} dirty={dirty} />

      <SlackAppCard s={s} setS={setS} dirty={dirty} />

      <HarvestSettings s={s} setS={setS} dirty={dirty} />

      <section className="card">
        <h2>🔌 Ticket sources</h2>
        <div className="desc">Imported tickets land in Backlog. Progress is mirrored back as comments and status changes. Tokens can also come from GITHUB_TOKEN / LINEAR_API_KEY / JIRA_TOKEN / SENTRY_TOKEN env vars.</div>

        <Conn title="🐙 GitHub Issues" on={s.connectors.github.enabled} onToggle={(v) => conn('github', { enabled: v })} onTest={() => test('github')} onSync={() => sync('github')}>
          <label className="field">Repository<input className="input mono" placeholder="owner/repo" value={s.connectors.github.repo} onChange={(e) => conn('github', { repo: e.target.value })} /></label>
          <label className="field">Only issues labeled<input className="input" value={s.connectors.github.label} onChange={(e) => conn('github', { label: e.target.value })} /></label>
          <label className="field">Token<input className="input mono" type="password" placeholder="ghp_… (repo scope)" value={s.connectors.github.token} onChange={(e) => conn('github', { token: e.target.value })} /></label>
        </Conn>

        <Conn title="◐ Linear" on={s.connectors.linear.enabled} onToggle={(v) => conn('linear', { enabled: v })} onTest={() => test('linear')} onSync={() => sync('linear')}>
          <label className="field">Team key<input className="input mono" placeholder="ENG" value={s.connectors.linear.teamKey} onChange={(e) => conn('linear', { teamKey: e.target.value })} /></label>
          <label className="field">Pull issues in state<input className="input" value={s.connectors.linear.stateName} onChange={(e) => conn('linear', { stateName: e.target.value })} /></label>
          <label className="field">API key<input className="input mono" type="password" placeholder="lin_api_…" value={s.connectors.linear.apiKey} onChange={(e) => conn('linear', { apiKey: e.target.value })} /></label>
        </Conn>

        <Conn title="◆ Jira" on={s.connectors.jira.enabled} onToggle={(v) => conn('jira', { enabled: v })} onTest={() => test('jira')} onSync={() => sync('jira')}>
          <label className="field">Site URL<input className="input mono" placeholder="https://acme.atlassian.net" value={s.connectors.jira.baseUrl} onChange={(e) => conn('jira', { baseUrl: e.target.value })} /></label>
          <label className="field">Email<input className="input" value={s.connectors.jira.email} onChange={(e) => conn('jira', { email: e.target.value })} /></label>
          <label className="field">API token<input className="input mono" type="password" value={s.connectors.jira.token} onChange={(e) => conn('jira', { token: e.target.value })} /></label>
          <label className="field">JQL<input className="input mono" value={s.connectors.jira.jql} onChange={(e) => conn('jira', { jql: e.target.value })} /></label>
        </Conn>

        <Conn title="🐞 Sentry" on={s.connectors.sentry.enabled} onToggle={(v) => conn('sentry', { enabled: v })} onTest={() => test('sentry')} onSync={() => sync('sentry')}>
          <label className="field">Organization slug<input className="input mono" placeholder="acme" value={s.connectors.sentry.org} onChange={(e) => conn('sentry', { org: e.target.value })} /></label>
          <label className="field">Project slug<input className="input mono" placeholder="web" value={s.connectors.sentry.project} onChange={(e) => conn('sentry', { project: e.target.value })} /></label>
          <label className="field">Auth token<input className="input mono" type="password" placeholder="sntrys_… (project:read, event:read, issue resolve)" value={s.connectors.sentry.token} onChange={(e) => conn('sentry', { token: e.target.value })} /></label>
          <label className="field">Issues to import<input className="input mono" value={s.connectors.sentry.query} onChange={(e) => conn('sentry', { query: e.target.value })} /></label>
          <label className="field">Sentry address<input className="input mono" value={s.connectors.sentry.baseUrl} onChange={(e) => conn('sentry', { baseUrl: e.target.value })} /></label>
          <label className="field">Webhook secret (optional)<input className="input mono" type="password" placeholder="for POST /api/webhooks/sentry" value={s.connectors.sentry.webhookSecret} onChange={(e) => conn('sentry', { webhookSecret: e.target.value })} /></label>
          <div className="row"><Toggle on={s.connectors.sentry.autoImport} onChange={(v) => conn('sentry', { autoImport: v })} /> <span className="small">Import new issues every 10 minutes</span></div>
        </Conn>
      </section>

      <PluginsCard s={s} setS={setS} />

      <ClaudeCard />

      <section className="card">
        <h2>🎨 Make it yours</h2>
        <div className="desc">Saved in this browser.</div>
        <div className="row wrap" style={{ gap: 18 }}>
          <div className="field">Theme
            <div className="seg">{(['system', 'light', 'dark'] as const).map((t) => <button key={t} className={prefs.theme === t ? 'on' : ''} onClick={() => setPref('theme', t)}>{t}</button>)}</div>
          </div>
          <div className="field">Density
            <div className="seg">{(['comfortable', 'compact'] as const).map((t) => <button key={t} className={prefs.density === t ? 'on' : ''} onClick={() => setPref('density', t)}>{t}</button>)}</div>
          </div>
          <div className="field">Accent
            <div className="swatches">
              {ACCENTS.map((c) => <span key={c} className={`swatch ${prefs.accent === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setPref('accent', c)} />)}
              <input type="color" value={prefs.accent} onChange={(e) => setPref('accent', e.target.value)} style={{ width: 24, height: 24, border: 0, padding: 0, background: 'none' }} />
            </div>
          </div>
          <label className="field">Open on
            <select className="select" value={prefs.defaultView} onChange={(e) => setPref('defaultView', e.target.value as View)}>
              {(['inbox', 'office', 'board', 'reports', 'trophies', 'agents', 'activity'] as View[]).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="field">Group board by
            <select className="select" value={prefs.groupBy} onChange={(e) => setPref('groupBy', e.target.value as Prefs['groupBy'])}>
              <option value="none">Nothing</option><option value="priority">Priority</option><option value="source">Source</option>
            </select>
          </label>
        </div>
        <div className="field">Board columns (click to hide/show)
          <div className="checks">
            {ALL_COLUMNS.map((c) => (
              <label key={c}>
                <input type="checkbox" checked={prefs.columns.includes(c)} onChange={(e) => setPref('columns', e.target.checked ? ALL_COLUMNS.filter((x) => x === c || prefs.columns.includes(x)) : prefs.columns.filter((x) => x !== c))} />
                {STAGE_META[c].icon} {STAGE_META[c].label}
              </label>
            ))}
          </div>
        </div>
        <div className="field">Card shows
          <div className="checks">
            {(Object.keys(prefs.cardFields) as Array<keyof Prefs['cardFields']>).map((k) => (
              <label key={k}><input type="checkbox" checked={prefs.cardFields[k]} onChange={(e) => setPref('cardFields', { ...prefs.cardFields, [k]: e.target.checked })} /> {k}</label>
            ))}
          </div>
        </div>
        <div className="field">Header widgets
          <div className="checks">
            {(Object.keys(prefs.widgets) as Array<keyof Prefs['widgets']>).map((k) => (
              <label key={k}><input type="checkbox" checked={prefs.widgets[k]} onChange={(e) => setPref('widgets', { ...prefs.widgets, [k]: e.target.checked })} /> {k}</label>
            ))}
          </div>
        </div>
        <div className="field">Gamification
          <div className="checks">
            <label><input type="checkbox" checked={prefs.game.enabled} onChange={(e) => setPref('game', { ...prefs.game, enabled: e.target.checked })} /> XP, levels, quests and office upgrades</label>
            <label><input type="checkbox" checked={prefs.game.celebrations} disabled={!prefs.game.enabled} onChange={(e) => setPref('game', { ...prefs.game, celebrations: e.target.checked })} /> Celebrations when things ship</label>
            <label><input type="checkbox" checked={prefs.game.sound} disabled={!prefs.game.enabled} onChange={(e) => setPref('game', { ...prefs.game, sound: e.target.checked })} /> Sound</label>
          </div>
        </div>
        <div><button className="btn ghost sm" onClick={() => confirm('Reset all UI preferences, including office layout and characters?') && reset()}>Reset UI preferences</button></div>
      </section>
    </div>
  );
}

function Conn({ title, on, onToggle, onTest, onSync, children }: { title: string; on: boolean; onToggle: (v: boolean) => void; onTest: () => void; onSync: () => void; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14, display: 'grid', gap: 10 }}>
      <div className="row">
        <Toggle on={on} onChange={onToggle} />
        <strong>{title}</strong>
        <span style={{ flex: 1 }} />
        {on && <><button className="btn sm" onClick={onTest}>Test</button><button className="btn sm" onClick={onSync}>⟳ Import now</button></>}
      </div>
      {on && <div className="grid2">{children}</div>}
    </div>
  );
}

function HarvestSettings({ s, setS, dirty }: { s: S; setS: (s: S) => void; dirty: boolean }) {
  const ui = useUI();
  const hv = useHarvest();
  const h = s.harvest;
  const connected = !!hv.status?.configured && !hv.status.error;
  const { projects, error, reload } = useHarvestProjects(h.enabled && connected);
  const set = (patch: Partial<S['harvest']>) => setS({ ...s, harvest: { ...h, ...patch } });
  const project = projects?.find((p) => p.id === h.projectId);

  const test = async () => {
    try {
      if (dirty) await api.updateSettings(s);
      ui.toast(`✓ ${(await api.harvestTest()).message}`);
      await hv.refresh(true);
      await reload();
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };

  return (
    <section className="card">
      <h2>⏱ Harvest time tracking</h2>
      <div className="desc">Track your time as PM: reviews, decisions and sign-offs. Get a personal access token and your account id from Harvest ID → Developers.</div>
      <div className="row"><Toggle on={h.enabled} onChange={(v) => set({ enabled: v })} /> <span>Use Harvest</span></div>
      {h.enabled && (
        <>
          <div className="grid2">
            <label className="field">Account ID<input className="input mono" value={h.accountId} onChange={(e) => set({ accountId: e.target.value })} /></label>
            <label className="field">Personal access token<input className="input mono" type="password" value={h.token} onChange={(e) => set({ token: e.target.value })} /></label>
          </div>
          <div className="row"><button className="btn sm" onClick={test}>Test & load projects</button>{error && <span className="small" style={{ color: 'var(--bad)' }}>{error}</span>}</div>
          <div className="grid2">
            <label className="field">Default project
              <select className="select" value={h.projectId ?? ''} onChange={(e) => {
                const p = projects?.find((x) => x.id === Number(e.target.value));
                set({ projectId: p?.id, taskId: p?.tasks[0]?.id });
              }}>
                <option value="">{projects ? 'Choose…' : 'Test the connection to load projects'}</option>
                {projects?.map((p) => <option key={p.id} value={p.id}>{p.client ? `${p.client} — ` : ''}{p.name}</option>)}
              </select>
            </label>
            <label className="field">Default task
              <select className="select" value={h.taskId ?? ''} onChange={(e) => set({ taskId: Number(e.target.value) })}>
                {(project?.tasks ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          </div>
          <div className="row"><Toggle on={h.autoTimer} onChange={(v) => set({ autoTimer: v })} /> <span>Start a timer automatically when I open something that needs me, and stop it when I decide</span></div>
          <div className="small muted">Tickets can bill to a different project from their drawer. Tokens can also come from HARVEST_TOKEN / HARVEST_ACCOUNT_ID.</div>
        </>
      )}
    </section>
  );
}
