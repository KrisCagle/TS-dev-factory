import { useEffect, useState } from 'react';
import { api } from '../api';
import { Toggle } from '../components/Bits';
import { ROLE_META, ROLES } from '../meta';
import { useFactory } from '../state';
import { useUI } from '../ui';
import type { AgentConfig } from '../types';

const MODELS = ['opus', 'sonnet', 'haiku'];
const TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'Task'];

export function Agents() {
  const { agents, tickets } = useFactory();
  return (
    <div className="agents-grid">
      {ROLES.map((role) => {
        const a = agents.find((x) => x.role === role);
        if (!a) return null;
        const working = tickets.filter((t) => t.activeAgent === role && ['planning', 'coding', 'testing', 'reviewing'].includes(t.stage));
        return <AgentCard key={role} a={a} working={working.map((t) => t.key)} />;
      })}
      <div className="card agent-card" style={{ alignContent: 'start' }}>
        <strong>How the pipeline flows</strong>
        <div className="small muted" style={{ display: 'grid', gap: 6 }}>
          <span>📥 Ready → 🧭 Planner → ⌨️ Coder → 🧪 Tester → 🔍 Reviewer → ✋ You → 🚀 Shipped</span>
          <span>Failed tests or requested changes loop back to the Coder, up to the rework limit in Settings — then it escalates to you.</span>
          <span>Disable any role to skip it. The Reviewer is recommended as the quality gate before your sign-off.</span>
          <span>Each agent runs the Claude Agent SDK inside the ticket's own git worktree, and picks up your repo's CLAUDE.md.</span>
        </div>
      </div>
    </div>
  );
}

function AgentCard({ a, working }: { a: AgentConfig; working: string[] }) {
  const ui = useUI();
  const [draft, setDraft] = useState(a);
  useEffect(() => setDraft(a), [a]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(a);
  const save = async (patch?: Partial<AgentConfig>) => {
    try {
      await api.updateAgent(a.role, patch ?? draft);
      ui.toast(`${a.name} updated`);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };

  return (
    <div className="card agent-card" style={{ opacity: a.enabled ? 1 : 0.7 }}>
      <div className="hd">
        <span className="avatar" style={{ background: a.color }}>{ROLE_META[a.role].icon}</span>
        <div style={{ flex: 1 }}>
          <input className="input" style={{ fontWeight: 650, padding: '3px 8px', border: 0, background: 'transparent' }} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <div className="small muted" style={{ paddingLeft: 8 }}>{ROLE_META[a.role].desc}</div>
        </div>
        <Toggle on={a.enabled} onChange={(v) => save({ enabled: v })} title={a.enabled ? 'Enabled' : 'Disabled'} />
      </div>
      <div className="small">{working.length ? <>🟢 Working on <span className="mono">{working.join(', ')}</span></> : <span className="muted">⚪ Idle</span>}</div>
      <div className="grid2">
        <label className="field">Model
          <select className="select" value={MODELS.includes(draft.model) ? draft.model : 'custom'} onChange={(e) => setDraft({ ...draft, model: e.target.value === 'custom' ? '' : e.target.value })}>
            {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            <option value="custom">custom model ID…</option>
          </select>
          {!MODELS.includes(draft.model) && <input className="input mono" placeholder="claude-…" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />}
        </label>
        <label className="field">Max turns
          <input className="input" type="number" min={1} max={500} value={draft.maxTurns} onChange={(e) => setDraft({ ...draft, maxTurns: Number(e.target.value) })} />
        </label>
      </div>
      <div className="field">Tools this agent may use
        <div className="checks">
          {TOOLS.map((tool) => (
            <label key={tool}>
              <input type="checkbox" checked={draft.allowedTools.includes(tool)} onChange={(e) => setDraft({ ...draft, allowedTools: e.target.checked ? [...draft.allowedTools, tool] : draft.allowedTools.filter((x) => x !== tool) })} />
              {tool}
            </label>
          ))}
        </div>
      </div>
      <label className="field">System prompt
        <textarea className="textarea mono" style={{ minHeight: 170, fontSize: 12 }} value={draft.systemPrompt} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })} />
      </label>
      <div className="row">
        <span className="field" style={{ margin: 0 }}>Color</span>
        <input type="color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} style={{ width: 34, height: 26, border: 0, background: 'none', padding: 0 }} />
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => confirm(`Reset ${a.name} to defaults?`) && api.resetAgent(a.role).then(() => ui.toast('Reset to defaults'))}>Reset</button>
        <button className="btn primary sm" disabled={!dirty} onClick={() => save()}>Save</button>
      </div>
    </div>
  );
}
