import { useState } from 'react';
import { api } from '../api';
import { Toggle } from '../components/Bits';
import { useFactory } from '../state';
import { useUI } from '../ui';
import type { Settings as S } from '../types';

/** Claude Code sessions: which process plugins they load and how they ask for permission. */
export function EngineCard({ s, setS }: { s: S; setS: (s: S) => void }) {
  const { engine } = useFactory();
  const e = s.engine;
  const set = (patch: Partial<S['engine']>) => setS({ ...s, engine: { ...e, ...patch } });
  const [dirs, setDirs] = useState(e.pluginDirs.join('\n'));
  return (
    <section className="card">
      <h2>🧵 Sessions</h2>
      <div className="desc">
        Sessions are Claude Code in your repos (Sessions tab, pipelines, and the assistant start them). Point them at your team’s Claude Code plugins so they follow your process —
        e.g. factory-assistant’s <code>process-plugin</code>. Nothing is copied: they’re loaded from where they live.
      </div>
      <label className="field">Plugin folders (one per line)
        <textarea className="textarea mono small" style={{ minHeight: 54 }} placeholder="~/Documents/factory-assistant/process-plugin" value={dirs} onChange={(x) => setDirs(x.target.value)} onBlur={() => set({ pluginDirs: dirs.split('\n').map((d) => d.trim()).filter(Boolean) })} />
      </label>
      <div className="row"><Toggle on={e.autoDetectProcessPlugin} onChange={(v) => set({ autoDetectProcessPlugin: v })} /> <span className="small">Also look for a factory-assistant checkout (~/Documents, ~/workspace, ~/code)</span></div>
      <div className="small">
        Loading now: {engine?.pluginDirs.length ? engine.pluginDirs.map((d) => <code key={d} style={{ marginRight: 6 }}>{d}</code>) : <span className="muted">none</span>}
      </div>
      <div className="row wrap" style={{ gap: 18 }}>
        <div className="field">Permissions
          <div className="seg">
            {([['ask', 'Ask me'], ['acceptEdits', 'Edits OK, ask for the rest'], ['bypass', 'Never ask']] as const).map(([v, l]) => (
              <button key={v} className={e.permissionMode === v ? 'on' : ''} onClick={() => set({ permissionMode: v })}>{l}</button>
            ))}
          </div>
        </div>
        <label className="field">Model<input className="input mono" style={{ width: 120 }} value={e.model} onChange={(x) => set({ model: x.target.value })} /></label>
        <label className="field">Run at once<input className="input" type="number" min={1} max={10} style={{ width: 70 }} value={e.maxParallel} onChange={(x) => set({ maxParallel: Math.max(1, Number(x.target.value) || 1) })} /></label>
      </div>
      {e.permissionMode === 'bypass' && <div className="small" style={{ color: 'var(--warn)' }}>Sessions will run any command without asking. Only use this on repos and machines you’re comfortable with.</div>}
      <div className="row"><Toggle on={e.userSettings} onChange={(v) => set({ userSettings: v })} /> <span className="small">Load my own Claude Code settings and skills (~/.claude)</span></div>
      <div className="row"><Toggle on={e.nudge} onChange={(v) => set({ nudge: v })} /> <span className="small">Nudge a session once when it stops without reporting back</span></div>
    </section>
  );
}

/** Scarif remote workers. */
export function ScarifCard({ s, setS }: { s: S; setS: (s: S) => void }) {
  const { engine, scarif } = useFactory();
  const ui = useUI();
  const c = s.scarif;
  const set = (patch: Partial<S['scarif']>) => setS({ ...s, scarif: { ...c, ...patch } });
  return (
    <section className="card">
      <h2>🛰 Scarif</h2>
      <div className="desc">
        Send tickets to Scarif droids and watch them on the board (On Scarif column) and in Sessions. The factory reads <code>~/.scarif/cli.json</code> from <code>scarif setup</code>, and sends work with the <code>scarif</code> CLI. Tickets need a Jira key and the project’s GitHub repo.
      </div>
      <div className="row"><Toggle on={c.enabled} onChange={(v) => set({ enabled: v })} /> <strong className="small">Use Scarif</strong>
        <span className="small muted">— CLI {engine?.scarifCli ? 'found ✓' : 'not found'} · login {engine?.scarifConfigured ? 'found ✓' : 'not found'}{scarif?.state === 'error' ? ` · ${scarif.error}` : ''}</span>
        <span className="grow" />
        <button className="btn sm" onClick={() => api.scarif(true).then((f) => ui.toast(f.state === 'ready' ? `Connected — ${f.workers.length} droid(s) on your jobs` : f.error ?? f.state)).catch((e) => ui.toast(`⚠ ${e.message}`))}>Test</button>
      </div>
      <div className="row wrap" style={{ gap: 12 }}>
        <label className="field">Server (optional)<input className="input mono" placeholder="from ~/.scarif/cli.json" value={c.url} onChange={(x) => set({ url: x.target.value })} /></label>
        <label className="field">Token (optional)<input className="input mono" type="password" value={c.token} onChange={(x) => set({ token: x.target.value })} /></label>
        <label className="field">Max points for a droid<input className="input" type="number" style={{ width: 70 }} value={c.maxPoints} onChange={(x) => set({ maxPoints: Number(x.target.value) || 13 })} /></label>
      </div>
      <div className="row"><Toggle on={c.useForPipelines} onChange={(v) => set({ useForPipelines: v })} /> <span className="small">Pipelines send tickets that fit to Scarif by default</span></div>
      <div className="row"><Toggle on={c.sessionTools} onChange={(v) => set({ sessionTools: v })} /> <span className="small">Give sessions Scarif’s tools (search the code index, check jobs)</span></div>
      <div className="row"><Toggle on={c.allowWrites} onChange={(v) => set({ allowWrites: v })} /> <span className="small">…including tools that change things (enqueue, edit Jira, message droids)</span></div>
    </section>
  );
}

/** Voice: free speech in and out. */
export function VoiceCard({ s, setS }: { s: S; setS: (s: S) => void }) {
  const a = s.assistant;
  const set = (patch: Partial<S['assistant']>) => setS({ ...s, assistant: { ...a, ...patch } });
  return (
    <section className="card">
      <h2>🎙 Voice & assistant</h2>
      <div className="desc">
        Hold <kbd>Right ⌥</kbd> (or the 🎙 button, bottom right) and talk. It’s free: listening uses the browser’s built-in speech recognition and replies use your Mac’s own voices.
        Safari recognizes speech on your Mac; Chrome sends audio to Google’s free service. For fully local listening, install whisper.cpp and set the command below.
      </div>
      <div className="row wrap" style={{ gap: 12 }}>
        <label className="field">Assistant model (live mode)<input className="input mono" style={{ width: 120 }} value={a.model} onChange={(x) => set({ model: x.target.value })} /></label>
        <div className="row"><Toggle on={a.speak} onChange={(v) => set({ speak: v })} /> <span className="small">Speak replies by default</span></div>
      </div>
      <label className="field">Local speech-to-text command (optional)
        <input className="input mono" placeholder="whisper-cli -m ~/models/ggml-base.en.bin -nt -np -f {file}" value={a.whisperCommand} onChange={(x) => set({ whisperCommand: x.target.value })} />
      </label>
      <div className="small muted">
        Setup: <code>brew install whisper-cpp ffmpeg</code>, download a model (e.g. <code>ggml-base.en.bin</code>) into <code>~/models</code>, paste the command above, then pick “Local Whisper” in the assistant’s ⚙.
        <code>{'{file}'}</code> is replaced with the recording (converted to 16 kHz WAV).
      </div>
    </section>
  );
}
