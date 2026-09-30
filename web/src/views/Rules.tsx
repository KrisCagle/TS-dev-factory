import { useEffect, useState } from 'react';
import { api } from '../api';
import { useFactory } from '../state';
import { useUI } from '../ui';

type Loaded = Awaited<ReturnType<typeof api.rules>>;

const STARTER = `# House rules

These are read by every agent (Planner, Coder, Tester, Reviewer) on every ticket.

## Code
- Use TypeScript strict mode; no \`any\` unless there's a comment explaining why.
- Keep changes small and focused on the ticket.

## Tests
- Every bug fix gets a test that fails without the fix.

## Don't
- Don't add new dependencies without saying why in the PR description.
`;

/** Edit the conventions every agent follows. Lives in the repo's CLAUDE.md when possible. */
export function Rules() {
  const f = useFactory();
  const ui = useUI();
  const [pid, setPid] = useState(f.targetProjectId);
  const [data, setData] = useState<Loaded | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setPid(f.targetProjectId), [f.targetProjectId]);

  const load = () => api.rules(pid).then((d) => { setData(d); setText(d.text); setErr(null); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pid]);

  const dirty = data !== null && text !== data.text;
  const save = async () => {
    try {
      const d = await api.saveRules(pid, text);
      setData((cur) => (cur ? { ...cur, ...d } : null));
      setText(d.text);
      ui.toast(d.inRepo ? 'Saved to CLAUDE.md — commit it with your repo' : 'Saved');
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    }
  };
  const addRule = (r: string) => setText((t) => `${t.replace(/\s*$/, '')}\n- ${r.replace(/\n+/g, ' ').trim()}\n`);
  const project = f.projects.find((p) => p.id === pid);

  return (
    <div className="rules">
      <section className="card">
        <div className="row wrap">
          <h2 style={{ margin: 0 }}>📐 House rules</h2>
          {f.projects.length > 1 && (
            <select className="select" style={{ width: 'auto' }} value={pid} onChange={(e) => setPid(e.target.value)}>
              {f.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <span className="grow" />
          {dirty && <button className="btn" onClick={() => setText(data!.text)}>Discard</button>}
          <button className="btn primary" disabled={!dirty} onClick={save}>Save</button>
        </div>
        <div className="desc">
          Conventions every agent follows on {project?.name ?? 'this project'}: style, testing, things to avoid. They’re added to every agent’s instructions.{' '}
          {data && (data.inRepo
            ? <>Saved in <code>{data.where}</code>, so they travel with the repo and Claude Code uses them too.</>
            : <>No repo is set for this project yet, so they’re kept in the factory’s settings. Set a repo path in Settings → Projects to store them in its <code>CLAUDE.md</code>.</>)}
        </div>
        {err && <div className="empty">{err}</div>}
        {data && !text && <div className="row"><span className="muted small">No rules yet.</span><button className="btn sm" onClick={() => setText(STARTER)}>Start from a template</button></div>}
        <textarea className="input mono rules-edit" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder="# House rules…" />
      </section>

      {data && data.suggestions.length > 0 && (
        <section className="card">
          <h2>💡 Suggested from your feedback</h2>
          <div className="desc">Notes and review feedback you’ve given on tickets. If one keeps coming up, make it a rule so agents get it right the first time.</div>
          <ul className="sugg">
            {data.suggestions.map((sg, i) => (
              <li key={i}>
                <span>“{sg.text}”</span>
                <span className="muted small mono">{sg.ticket}</span>
                <span className="grow" />
                <button className="btn sm" onClick={() => addRule(sg.text)}>＋ Add as rule</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
