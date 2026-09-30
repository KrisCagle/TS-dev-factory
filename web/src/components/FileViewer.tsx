import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useUI } from '../ui';
import type { Ticket } from '../types';

/** Read-only code browser over a ticket's working copy. Changed files come first. */
export function FileViewer({ t }: { t: Ticket }) {
  const ui = useUI();
  const [list, setList] = useState<{ changed: string[]; files: string[]; live: boolean } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [doc, setDoc] = useState<{ content: string; note?: string } | null>(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.files(t.id).then((l) => {
      setList(l);
      setSel((s) => s ?? l.changed[0] ?? l.files[0] ?? null);
    }).catch((e) => setErr((e as Error).message));
  }, [t.id, t.diff]);

  useEffect(() => {
    if (!sel) return;
    setDoc(null);
    api.file(t.id, sel).then((f) => setDoc({
      content: f.content,
      note: f.fromDiff ? 'Simulated mode — showing what the diff adds.' : f.tooLarge ? 'Too large to show.' : f.binary ? 'Binary file.' : undefined,
    })).catch((e) => setDoc({ content: '', note: (e as Error).message }));
  }, [sel, t.id]);

  const changed = new Set(list?.changed ?? []);
  const others = useMemo(() => {
    const needle = q.toLowerCase();
    return (list?.files ?? []).filter((f) => !changed.has(f) && (!needle || f.toLowerCase().includes(needle))).slice(0, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, q]);

  // lines the diff added, to highlight them in the viewer
  const added = useMemo(() => {
    if (!sel || !t.diff) return new Set<number>();
    const out = new Set<number>();
    let inFile = false;
    let line = 0;
    for (const l of t.diff.split('\n')) {
      if (l.startsWith('diff --git')) inFile = l.endsWith(` b/${sel}`);
      else if (!inFile) continue;
      else if (l.startsWith('@@')) line = Number(l.match(/\+(\d+)/)?.[1] ?? 1) - 1;
      else if (l.startsWith('+') && !l.startsWith('+++')) out.add(++line);
      else if (!l.startsWith('-')) line++;
    }
    return out;
  }, [sel, t.diff]);

  if (err) return <div className="empty">{err}</div>;
  if (!list) return <div className="empty">Loading files…</div>;
  if (!list.files.length) return <div className="empty">No files yet — the Coder hasn’t changed anything.</div>;

  return (
    <div className="fview">
      <aside className="flist">
        <div className="row" style={{ marginBottom: 6 }}>
          <button className="btn sm" onClick={() => api.openEditor(t.id).then((r) => ui.toast(`Opened ${r.opened.split('/').pop()} in VS Code`)).catch((e) => ui.toast(`⚠ ${(e as Error).message}`))}>Open in VS Code ↗</button>
        </div>
        {list.changed.length > 0 && <div className="group-h">Changed ({list.changed.length})</div>}
        {list.changed.map((f) => (
          <button key={f} className={`fitem ch ${sel === f ? 'on' : ''}`} onClick={() => setSel(f)} title={f}>● {f}</button>
        ))}
        {list.live && (
          <>
            <div className="group-h">All files</div>
            <input className="input" style={{ margin: '4px 0' }} placeholder="Filter files…" value={q} onChange={(e) => setQ(e.target.value)} />
            {others.map((f) => (
              <button key={f} className={`fitem ${sel === f ? 'on' : ''}`} onClick={() => setSel(f)} title={f}>{f}</button>
            ))}
          </>
        )}
      </aside>
      <section className="fcode">
        <div className="fhead mono">{sel}{changed.has(sel ?? '') && <span className="chip" style={{ marginLeft: 8 }}>changed</span>}</div>
        {doc?.note && <div className="small muted" style={{ padding: '6px 10px' }}>{doc.note}</div>}
        {doc ? (
          <pre className="code">
            {doc.content.split('\n').map((l, i) => (
              <div key={i} className={`cl ${added.has(i + 1) ? 'add' : ''}`}><span className="ln">{i + 1}</span>{l || ' '}</div>
            ))}
          </pre>
        ) : <div className="empty">Loading…</div>}
      </section>
    </div>
  );
}

/** Start / open / stop the ticket's live preview. */
export function PreviewControls({ t, compact }: { t: Ticket; compact?: boolean }) {
  const ui = useUI();
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[] | null>(null);
  const p = t.preview;
  const running = p && (p.status === 'running' || p.status === 'starting');
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row wrap">
      {running ? (
        <>
          <a className={`btn sm ${p!.status === 'running' ? 'ok' : ''}`} href={p!.url} target="_blank" rel="noreferrer">
            {p!.status === 'running' ? `▶ Open preview :${p!.port} ↗` : `⏳ Starting preview :${p!.port}…`}
          </a>
          <button className="btn sm" disabled={busy} onClick={() => act(() => api.previewStop(t.id))}>■ Stop</button>
        </>
      ) : (
        <button className="btn sm" disabled={busy} title="Run your app from this ticket's branch on its own port" onClick={() => act(() => api.previewStart(t.id))}>▶ Preview this change</button>
      )}
      {p?.status === 'error' && <span className="small" style={{ color: 'var(--bad)' }}>Preview stopped: {p.error?.slice(0, 80)}</span>}
      {!compact && (running || p?.status === 'error') && (
        <button className="btn ghost sm" onClick={() => (logs ? setLogs(null) : api.previewLogs(t.id).then(setLogs))}>{logs ? 'Hide output' : 'Output'}</button>
      )}
      {logs && <pre className="code small" style={{ width: '100%', maxHeight: 180 }}>{logs.join('\n') || '(no output yet)'}</pre>}
    </div>
  );
}
