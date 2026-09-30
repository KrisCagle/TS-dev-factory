import { useEffect, useState } from 'react';
import { api } from '../api';
import { Toggle } from '../components/Bits';
import { STAGE_META } from '../meta';
import { ALL_COLUMNS, usePrefs, type Prefs, type View } from '../prefs';
import { useFactory } from '../state';
import { useUI } from '../ui';
import type { Settings as S, TicketSource } from '../types';

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
        <div className="desc">How agents run and where their work lands.</div>
        <div className="row">
          <div className="seg">
            <button className={s.mode === 'mock' ? 'on' : ''} onClick={() => setS({ ...s, mode: 'mock' })}>Simulated agents</button>
            <button className={s.mode === 'live' ? 'on' : ''} onClick={() => setS({ ...s, mode: 'live' })}>Live (Claude Agent SDK)</button>
          </div>
          {s.mode === 'live' && !hasApiKey && <span className="small" style={{ color: 'var(--warn)' }}>No ANTHROPIC_API_KEY on the server — live mode will use your Claude Code login if present.</span>}
        </div>
        <div className="grid2">
          <label className="field">Repository path (git)
            <input className="input mono" placeholder="/Users/you/code/my-app" value={s.repoPath} onChange={(e) => setS({ ...s, repoPath: e.target.value })} />
          </label>
          <label className="field">Base branch
            <input className="input mono" value={s.baseBranch} onChange={(e) => setS({ ...s, baseBranch: e.target.value })} />
          </label>
          <label className="field">Worktrees folder (optional)
            <input className="input mono" placeholder="defaults to <repo>-factory-worktrees" value={s.worktreesDir} onChange={(e) => setS({ ...s, worktreesDir: e.target.value })} />
          </label>
          <label className="field">When you approve
            <select className="select" value={s.mergeStrategy} onChange={(e) => setS({ ...s, mergeStrategy: e.target.value as S['mergeStrategy'] })}>
              <option value="local-merge">Merge into base branch locally</option>
              <option value="pull-request">Push branch & open a GitHub PR</option>
              <option value="none">Leave the branch for me</option>
            </select>
          </label>
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
        <div className="row"><Toggle on={s.gates.plan} onChange={(v) => setS({ ...s, gates: { ...s.gates, plan: v } })} /> <span>Approve every plan before coding starts</span></div>
        <div className="row"><Toggle on={s.gates.merge} onChange={(v) => setS({ ...s, gates: { ...s.gates, merge: v } })} /> <span>Sign off before anything merges or opens a PR</span></div>
      </section>

      <section className="card">
        <h2>🔌 Ticket sources</h2>
        <div className="desc">Imported tickets land in Backlog. Progress is mirrored back as comments and status changes. Tokens can also come from GITHUB_TOKEN / LINEAR_API_KEY / JIRA_TOKEN env vars.</div>

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
      </section>

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
              {(['office', 'board', 'agents', 'activity'] as View[]).map((v) => <option key={v} value={v}>{v}</option>)}
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
