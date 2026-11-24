import { useEffect, useState } from 'react';
import { api, type Report } from '../api';
import { Toggle } from '../components/Bits';
import { useFactory } from '../state';
import { useUI } from '../ui';

/** Daily standup and weekly report: what shipped, what's moving, what's waiting on you. */
export function Reports() {
  const f = useFactory();
  const ui = useUI();
  const [range, setRange] = useState<'day' | 'week'>('day');
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pid = f.project?.id;

  // refresh when the range/project changes and whenever tickets move
  const stamp = f.allTickets.reduce((a, t) => Math.max(a, t.updatedAt), 0);
  useEffect(() => {
    api.report(range, pid).then((x) => { setR(x); setErr(null); }).catch((e) => setErr((e as Error).message));
  }, [range, pid, stamp]);

  const open = (key: string) => {
    const t = f.allTickets.find((x) => x.key === key);
    if (t) ui.openTicket(t.id);
  };
  const copy = async () => {
    if (!r) return;
    try {
      await navigator.clipboard.writeText(r.markdown);
      ui.toast('Copied as Markdown');
    } catch {
      ui.toast('⚠ Couldn’t reach the clipboard');
    }
  };
  const slack = async () => {
    setBusy(true);
    try {
      await api.reportToSlack(range, pid);
      ui.toast('Posted to Slack');
    } catch (e) {
      ui.toast(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const s = f.settings;
  const slackReady = !!s?.notifications.slack.webhookUrl;
  const setReports = (patch: Partial<NonNullable<typeof s>['reports']>) => s && api.updateSettings({ reports: { ...s.reports, ...patch } }).catch((e) => ui.toast(`⚠ ${(e as Error).message}`));

  return (
    <div className="reports">
      <div className="row wrap">
        <div className="seg">
          <button className={range === 'day' ? 'on' : ''} onClick={() => setRange('day')}>Daily standup</button>
          <button className={range === 'week' ? 'on' : ''} onClick={() => setRange('week')}>Weekly report</button>
        </div>
        <span className="small muted">{r ? `${r.project} · ${r.from === r.to ? r.from : `${r.from} → ${r.to}`}` : ''}</span>
        <span className="grow" />
        <button className="btn" onClick={copy} disabled={!r}>⧉ Copy as Markdown</button>
        <button className="btn" onClick={slack} disabled={!r || busy || !slackReady} title={slackReady ? '' : 'Add a Slack webhook in Settings → Notifications'}>Post to Slack</button>
      </div>

      {err && <div className="empty">{err}</div>}
      {r && (
        <>
          <div className="rstats">
            <Stat n={r.shipped.length} label={range === 'day' ? 'shipped since last working day' : 'shipped this week'} tone="ok" />
            <Stat n={r.inProgress.length} label="in progress" />
            <Stat n={r.needsYou.length} label="waiting on you" tone={r.needsYou.length ? 'warn' : undefined} />
            <Stat n={r.blocked.length} label="blocked" tone={r.blocked.length ? 'bad' : undefined} />
            <Stat n={`$${r.spendUsd.toFixed(2)}`} label="agent spend" />
            {r.harvestHours !== undefined && <Stat n={`${r.harvestHours}h`} label="logged in Harvest" />}
          </div>
          {r.highlight && (
            <div className="card" style={{ padding: '12px 16px' }}>
              ⭐ <strong>Highlight of the week:</strong> <button className="linkish mono" onClick={() => open(r.highlight!.key)}>{r.highlight.key}</button> {r.highlight.title}
              {r.highlight.why && <span className="muted small"> — {r.highlight.why}</span>}
            </div>
          )}
          <div className="rgrid">
            <Section title="🚀 Shipped" empty="Nothing shipped yet" items={r.shipped.map((t) => ({ key: t.key, text: t.title, link: t.prUrl }))} onOpen={open} />
            <Section title="⚙️ In progress" empty="Nothing in flight" items={r.inProgress.map((t) => ({ key: t.key, text: t.title, sub: t.stage }))} onOpen={open} />
            <Section title="✋ Waiting on you" empty="All clear" items={r.needsYou.map((t) => ({ key: t.key, text: t.title }))} onOpen={open} />
            <Section title="⛔ Blocked" empty="Nothing blocked" items={r.blocked.map((t) => ({ key: t.key, text: t.title, sub: t.why }))} onOpen={open} />
          </div>
        </>
      )}

      {s && (
        <section className="card">
          <h2>🗓 Post the standup automatically</h2>
          <div className="row wrap">
            <Toggle on={s.reports.dailySlack} onChange={(v) => setReports({ dailySlack: v })} />
            <span>Post the daily standup to Slack every weekday at</span>
            <input className="input" type="time" style={{ width: 120 }} value={s.reports.dailyTime} onChange={(e) => setReports({ dailyTime: e.target.value })} />
            {!slackReady && <span className="small" style={{ color: 'var(--warn)' }}>Needs a Slack webhook — add one in <a href="#settings" onClick={(e) => { e.preventDefault(); ui.go('settings'); }}>Settings → Notifications</a>.</span>}
          </div>
          {s.reports.lastSent && <div className="small muted">Last posted {s.reports.lastSent}</div>}
        </section>
      )}
    </div>
  );
}

function Stat({ n, label, tone }: { n: number | string; label: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`rstat ${tone ?? ''}`}>
      <b>{n}</b>
      <span>{label}</span>
    </div>
  );
}

function Section({ title, items, empty, onOpen }: { title: string; empty: string; items: Array<{ key: string; text: string; sub?: string; link?: string }>; onOpen: (key: string) => void }) {
  return (
    <section className="card">
      <h2>{title} <span className="muted small">({items.length})</span></h2>
      {items.length === 0 ? <div className="muted small">{empty}</div> : (
        <ul className="rlist">
          {items.map((i) => (
            <li key={i.key}>
              <button className="linkish mono" onClick={() => onOpen(i.key)}>{i.key}</button> {i.text}
              {i.sub && <span className="muted small"> — {i.sub}</span>}
              {i.link && <> · <a href={i.link} target="_blank" rel="noreferrer" className="small">PR ↗</a></>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
