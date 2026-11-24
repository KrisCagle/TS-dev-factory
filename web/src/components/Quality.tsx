import { useState } from 'react';
import { api } from '../api';
import { useUI } from '../ui';
import { ago } from '../meta';
import type { Confidence, TestReport, Ticket } from '../types';

const LEVEL = {
  high: { label: 'High confidence', color: 'var(--ok)', icon: '🛡' },
  medium: { label: 'Check a few things', color: 'var(--warn)', icon: '🛡' },
  low: { label: 'Look closely', color: 'var(--bad)', icon: '⚠️' },
} as const;

/** The safety score pill, with the reasons on hover (or listed when expanded). */
export function SafetyBadge({ c, compact }: { c?: Confidence; compact?: boolean }) {
  if (!c) return null;
  const m = LEVEL[c.level];
  const why = c.reasons.map((r) => `${r.ok ? '✓' : '•'} ${r.text}`).join('\n');
  return (
    <span className={`safety ${c.level}`} title={`${m.label} — ${c.score}/100\n${why}`} style={{ ['--lvl' as string]: m.color }}>
      {m.icon} {compact ? c.score : `${c.score} · ${m.label}`}
    </span>
  );
}

export function SafetyReasons({ c }: { c?: Confidence }) {
  if (!c) return null;
  return (
    <ul className="reasons">
      {c.reasons.map((r, i) => <li key={i} className={r.ok ? 'ok' : 'bad'}>{r.ok ? '✓' : '!'} {r.text}</li>)}
    </ul>
  );
}

/** Acceptance criteria with the proof the Tester found for each. */
export function ProofList({ report }: { report?: TestReport }) {
  const cs = report?.criteria ?? [];
  if (!cs.length) return null;
  const proven = cs.filter((c) => c.status === 'proven').length;
  return (
    <div className="proof">
      <div className="small muted">Acceptance criteria · {proven}/{cs.length} proven</div>
      <ul>
        {cs.map((c, i) => (
          <li key={i} className={c.status}>
            <span className="pmark">{c.status === 'proven' ? '✓' : c.status === 'failed' ? '✗' : '?'}</span>
            <span>
              {c.criterion}
              {c.evidence ? <span className="small muted mono"> — {c.evidence}</span> : c.status === 'unproven' ? <span className="small" style={{ color: 'var(--warn)' }}> — no test proves this yet; check it by hand</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CoverageLine({ report }: { report?: TestReport }) {
  const c = report?.coverage;
  if (!c || c.before === undefined || c.after === undefined) return null;
  const d = +(c.after - c.before).toFixed(2);
  return (
    <div className="small">
      Coverage <strong>{c.before}% → {c.after}%</strong>{' '}
      <span style={{ color: d < 0 ? 'var(--bad)' : 'var(--ok)' }}>({d >= 0 ? '+' : ''}{d} pts)</span>
      {report?.testsAdded ? <span className="muted"> · {report.testsAdded} new test{report.testsAdded === 1 ? '' : 's'}</span> : null}
    </div>
  );
}

/** Everything that says "this is safe to ship" in one block, for the inbox and the ticket drawer. */
export function QualityPanel({ t, open: startOpen = false }: { t: Ticket; open?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  if (!t.confidence && !t.testReport?.criteria?.length) return null;
  return (
    <div className="qpanel">
      <div className="row wrap">
        <SafetyBadge c={t.confidence} />
        <CoverageLine report={t.testReport} />
        <span className="grow" />
        {t.confidence && <button className="linkish small" onClick={() => setOpen(!open)}>{open ? 'Hide why' : 'Why?'}</button>}
      </div>
      {open && <SafetyReasons c={t.confidence} />}
      <ProofList report={t.testReport} />
    </div>
  );
}

/** After shipping: smoke test status and the one-click revert. */
export function ShipPanel({ t }: { t: Ticket }) {
  const ui = useUI();
  const [busy, setBusy] = useState(false);
  const s = t.ship;
  if (!s) return null;
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      ui.toast(msg);
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const smoke = s.smoke;
  return (
    <div className="shippanel">
      <div className="row wrap">
        <strong>🚀 Shipped {ago(s.at)} ago</strong>
        {s.sha && <span className="chip mono">{s.sha.slice(0, 10)}</span>}
        {smoke && (
          <span className={`chip smoke-${smoke.state}`}>
            {smoke.state === 'running' ? '⏳ Smoke test running…' : smoke.state === 'passed' ? '✅ Smoke test passed' : smoke.state === 'failed' ? '🧯 Smoke test failed' : '– No smoke test'}
          </span>
        )}
        <span className="grow" />
        {s.sha && !s.reverted && smoke?.state !== 'running' && <button className="btn sm" disabled={busy} onClick={() => act(() => api.smoke(t.id), 'Smoke test started')}>Re-run smoke test</button>}
        {s.sha && !s.reverted && (
          <button className="btn sm danger" disabled={busy} onClick={() => confirm(`Revert ${t.key}? This ${s.how === 'local-merge' ? 'adds a revert commit to your base branch' : 'opens a revert pull request'}, and puts a redo ticket in Ready.`) && act(() => api.revert(t.id, { redo: true }), `Reverted ${t.key} — redo queued`)}>
            ↩ Revert & redo
          </button>
        )}
      </div>
      {s.reverted && (
        <div className="small" style={{ color: 'var(--warn)' }}>
          ↩ Reverted {ago(s.reverted.at)} ago{s.reverted.prUrl ? <> — <a href={s.reverted.prUrl} target="_blank" rel="noreferrer">revert PR ↗</a></> : s.reverted.sha ? <> as <span className="mono">{s.reverted.sha.slice(0, 10)}</span></> : null}
        </div>
      )}
      {smoke?.output && smoke.state !== 'passed' && <pre className="code small" style={{ maxHeight: 180 }}>{smoke.output}</pre>}
    </div>
  );
}
