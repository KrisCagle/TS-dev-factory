import { useEffect, useState } from 'react';
import { api, type PluginsSummary } from '../api';
import { Toggle } from '../components/Bits';
import { useFactory } from '../state';
import { useUI } from '../ui';
import type { Settings as S } from '../types';

/** Factory plugins: what's loaded, what each adds, on/off, and import buttons for plugin sources. */
export function PluginsCard({ s, setS }: { s: S; setS: (s: S) => void }) {
  const ui = useUI();
  const { targetProjectId } = useFactory();
  const [sum, setSum] = useState<PluginsSummary | null>(null);
  useEffect(() => {
    api.plugins().then(setSum).catch(() => undefined);
  }, [s.plugins]);
  const on = (name: string) => s.plugins?.[name]?.enabled !== false;
  const toggle = (name: string, v: boolean) => setS({ ...s, plugins: { ...(s.plugins ?? {}), [name]: { ...(s.plugins?.[name] ?? {}), enabled: v } } });
  const sync = async (id: string) => {
    try {
      const r = await api.pluginSync(id, targetProjectId);
      ui.toast(`Imported ${r.created} new of ${r.fetched}`);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };
  return (
    <section className="card">
      <h2>🔌 Plugins</h2>
      <div className="desc">
        Add agent roles, quality gates, ticket sources and office rooms with small JavaScript files in{' '}
        <code>{sum?.dir ?? 'plugins/'}</code>. Copy one of the examples from <code>plugins/examples/</code> to start, then restart the factory.
        Plugins run with full access to your machine, so only use ones you trust.
      </div>
      {!sum?.plugins.length && <div className="small muted">No plugins loaded.</div>}
      {sum?.plugins.map((p) => {
        const adds = [...p.roles.map((r) => `agent: ${r}`), ...p.gates.map((g) => `gate: ${g}`), ...p.sources.map((x) => `source: ${x}`), ...p.rooms.map((r) => `room: ${r}`)];
        const source = sum.sources.find((x) => x.plugin === p.name);
        return (
          <div key={p.name} className="plug">
            <div className="row">
              <Toggle on={on(p.name) && !p.error} onChange={(v) => toggle(p.name, v)} />
              <strong>{p.name}</strong>
              {p.description && <span className="small muted">{p.description}</span>}
              <span className="grow" />
              {source && on(p.name) && <button className="btn sm" onClick={() => sync(source.id)}>⟳ Import now</button>}
            </div>
            {p.error ? <div className="small" style={{ color: 'var(--bad)' }}>Couldn’t load: {p.error}</div> : adds.length > 0 && <div className="row wrap">{adds.map((a) => <span key={a} className="chip">{a}</span>)}</div>}
          </div>
        );
      })}
    </section>
  );
}

/** Approve from Slack: a Slack app over Socket Mode. */
export function SlackAppCard({ s, setS, dirty }: { s: S; setS: (s: S) => void; dirty: boolean }) {
  const ui = useUI();
  const { slackApp } = useFactory();
  const a = s.slackApp;
  const set = (patch: Partial<S['slackApp']>) => setS({ ...s, slackApp: { ...a, ...patch } });
  const test = async () => {
    try {
      if (dirty) await api.updateSettings(s);
      ui.toast(`✓ ${(await api.slackAppTest()).message}`);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };
  return (
    <section className="card">
      <h2>💬 Approve from Slack</h2>
      <div className="desc">
        Sign-offs and decisions are posted to a channel with buttons: approve, send back with a note, retry, revert. It connects over Slack’s Socket Mode, so it works without a public URL.
        Create the Slack app from <code>integrations/slack/manifest.json</code> (api.slack.com/apps → Create from manifest), install it, and paste its tokens here.
      </div>
      <div className="row">
        <Toggle on={a.enabled} onChange={(v) => set({ enabled: v })} /> <span>Use the Slack app</span>
        {a.enabled && <span className={`chip ${slackApp?.connected ? 'smoke-passed' : ''}`}>{slackApp?.connected ? '● Connected' : slackApp?.error ? `○ ${slackApp.error}` : '○ Not connected'}</span>}
        <span className="grow" />
        {a.enabled && <button className="btn sm" onClick={test}>Test</button>}
      </div>
      {a.enabled && (
        <div className="grid2">
          <label className="field">Bot token<input className="input mono" type="password" placeholder="xoxb-…" value={a.botToken} onChange={(e) => set({ botToken: e.target.value })} /></label>
          <label className="field">App-level token (Socket Mode)<input className="input mono" type="password" placeholder="xapp-…" value={a.appToken} onChange={(e) => set({ appToken: e.target.value })} /></label>
          <label className="field">Channel<input className="input mono" placeholder="#factory or C0123ABCD" value={a.channel} onChange={(e) => set({ channel: e.target.value })} /></label>
          <label className="field">Who can approve (Slack user IDs, empty = anyone in the channel)
            <input className="input mono" placeholder="U0123ABCD, U0456EFGH" value={a.approvers.join(', ')} onChange={(e) => set({ approvers: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
          </label>
          <label className="field">Factory address (for “Open in factory” links)<input className="input mono" value={a.factoryUrl} onChange={(e) => set({ factoryUrl: e.target.value })} /></label>
        </div>
      )}
    </section>
  );
}

/** How to drive the factory from Claude Code and Claude Desktop. */
export function ClaudeCard() {
  const ui = useUI();
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => ui.toast('Copied'), () => ui.toast('⚠ Couldn’t reach the clipboard'));
  const steps = ['/plugin marketplace add KrisCagle/TS-dev-factory', '/plugin install factory@ai-dev-factory'];
  const desktop = JSON.stringify({ mcpServers: { 'ai-dev-factory': { command: 'node', args: ['/path/to/ai-dev-factory/integrations/claude-code-plugin/mcp/factory-mcp.mjs'], env: { FACTORY_URL: location.origin } } } }, null, 2);
  return (
    <section className="card">
      <h2>🤖 Use it from Claude</h2>
      <div className="desc">Run the floor from Claude Code with slash commands, or let Claude Desktop and Cowork create tickets, check status and clear your inbox.</div>
      <div className="field">Claude Code — run these in Claude Code
        {steps.map((c) => (
          <div key={c} className="row"><code className="cmd grow">{c}</code><button className="btn sm" onClick={() => copy(c)}>Copy</button></div>
        ))}
        <div className="small muted">Then: <code>/factory:status</code>, <code>/factory:new &lt;idea&gt;</code>, <code>/factory:inbox</code>, <code>/factory:approve FAC-12</code>, <code>/factory:sendback FAC-12 &lt;note&gt;</code>, <code>/factory:ask FAC-12 &lt;question&gt;</code>, <code>/factory:standup</code>.</div>
      </div>
      <div className="field">Claude Desktop — add to <code>claude_desktop_config.json</code>
        <pre className="code small">{desktop}</pre>
        <div><button className="btn sm" onClick={() => copy(desktop)}>Copy</button></div>
      </div>
    </section>
  );
}
