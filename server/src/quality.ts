import type { Confidence, CoverageReport, CriterionProof, Project, QualitySettings, Ticket } from './types.js';

/**
 * Peace-of-mind checks between the agents and your sign-off:
 * acceptance-criteria proof, the coverage gate and the safety score.
 * Everything here is pure so it can be unit-tested and reused by the UI.
 */

export const DEFAULT_QUALITY: QualitySettings = {
  requireProof: false,
  coverage: { enabled: true, maxDropPct: 0.5 },
  smoke: true,
};

export const DEFAULT_RISKY_PATHS = ['migrations/', 'migrate', 'auth', 'payment', 'billing', '.env', 'secrets', 'Dockerfile', '.github/workflows/', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];

/** The acceptance criteria written in a ticket: the list under an "Acceptance criteria" heading, or any checkboxes. */
export function parseCriteria(description: string): string[] {
  const lines = description.split('\n');
  const item = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+?)\s*$/;
  const start = lines.findIndex((l) => /^\s*(#{1,6}\s*|\*\*)?\s*acceptance criteria\b/i.test(l));
  const out: string[] = [];
  if (start >= 0) {
    for (const l of lines.slice(start + 1)) {
      if (/^\s*#{1,6}\s/.test(l) || /^\s*\*\*[^*]+\*\*\s*$/.test(l)) break;
      const m = l.match(item);
      if (m) out.push(m[1]);
    }
  }
  if (!out.length) {
    for (const l of lines) {
      const m = l.match(/^\s*[-*+]\s+\[[ xX]\]\s*(.+?)\s*$/);
      if (m) out.push(m[1]);
    }
  }
  return out.slice(0, 20);
}

/** Line up the Tester's proof with the ticket's criteria, so nothing silently drops off the list. */
export function alignProof(criteria: string[], reported: CriterionProof[] = []): CriterionProof[] {
  if (!criteria.length) return reported;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  return criteria.map((c, i) => {
    const hit = reported.find((r) => norm(r.criterion) === norm(c)) ?? reported.find((r) => norm(r.criterion).includes(norm(c).slice(0, 24)) || norm(c).includes(norm(r.criterion).slice(0, 24))) ?? reported[i];
    return hit ? { ...hit, criterion: c } : { criterion: c, status: 'unproven' as const };
  });
}

export function unproven(t: Ticket) {
  return (t.testReport?.criteria ?? []).filter((c) => c.status !== 'proven');
}

/** Coverage gate: did the change lower coverage by more than allowed? */
export function coverageVerdict(c: CoverageReport | undefined, maxDropPct: number): { ok: boolean; skipped?: boolean; message: string } {
  if (!c || c.before === undefined || c.after === undefined) return { ok: true, skipped: true, message: 'Coverage not measured for this project.' };
  const drop = +(c.before - c.after).toFixed(2);
  if (drop > maxDropPct) return { ok: false, message: `Coverage dropped from ${c.before}% to ${c.after}% (−${drop} pts, limit ${maxDropPct}).` };
  const delta = +(c.after - c.before).toFixed(2);
  return { ok: true, message: `Coverage ${c.before}% → ${c.after}% (${delta >= 0 ? '+' : ''}${delta} pts).` };
}

/** Files a diff touches. */
export function changedFiles(diff = ''): string[] {
  const out = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) out.add(m[2]);
  return [...out];
}

export function diffSize(diff = '') {
  let added = 0;
  let removed = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) added++;
    else if (l.startsWith('-') && !l.startsWith('---')) removed++;
  }
  return { added, removed, total: added + removed };
}

export function riskyFiles(files: string[], patterns: string[] = DEFAULT_RISKY_PATHS) {
  const ps = patterns.map((p) => p.trim().toLowerCase()).filter(Boolean);
  return files.filter((f) => ps.some((p) => f.toLowerCase().includes(p)));
}

/**
 * The safety score shown on every sign-off: starts at 100 and loses points for anything
 * that should make you look closer. The reasons say exactly why.
 */
export function confidence(t: Ticket, project?: Pick<Project, 'riskyPaths'>, quality: QualitySettings = DEFAULT_QUALITY): Confidence {
  const reasons: Confidence['reasons'] = [];
  let score = 100;
  const hit = (pts: number, text: string) => { score -= pts; reasons.push({ ok: false, text }); };
  const good = (text: string) => reasons.push({ ok: true, text });

  const tr = t.testReport;
  if (!tr) hit(30, 'No test run recorded');
  else if (!tr.passed) hit(40, 'Tests are failing');
  else good(tr.testsAdded ? `Tests pass, ${tr.testsAdded} new test${tr.testsAdded === 1 ? '' : 's'} added` : 'Tests pass');
  if (tr?.passed && tr.testsAdded === 0) hit(10, 'No new tests were added');

  const criteria = tr?.criteria ?? [];
  if (criteria.length) {
    const missing = criteria.filter((c) => c.status !== 'proven');
    if (missing.length) hit(Math.min(30, 12 * missing.length), `${missing.length} of ${criteria.length} acceptance criteria without proof`);
    else good(`All ${criteria.length} acceptance criteria proven`);
  }

  const cov = coverageVerdict(tr?.coverage, quality.coverage.maxDropPct);
  if (!cov.skipped) (cov.ok ? good(cov.message) : hit(15, cov.message));

  if (t.ci) {
    if (t.ci.state === 'success') good('CI is green');
    else if (t.ci.state === 'failure') hit(30, 'CI is red');
    else if (t.ci.state === 'pending') hit(10, 'CI still running');
  }

  const size = diffSize(t.diff);
  if (size.total > 800) hit(20, `Large change: ${size.total} lines`);
  else if (size.total > 300) hit(10, `Medium-sized change: ${size.total} lines`);
  else if (size.total > 0) good(`Small change: ${size.total} lines`);

  const risky = riskyFiles(changedFiles(t.diff), project?.riskyPaths?.length ? project.riskyPaths : DEFAULT_RISKY_PATHS);
  if (risky.length) hit(Math.min(25, 10 + 5 * risky.length), `Touches sensitive files: ${risky.slice(0, 3).join(', ')}${risky.length > 3 ? '…' : ''}`);

  const major = (t.review?.comments ?? []).filter((c) => c.severity === 'blocker' || c.severity === 'major').length;
  if (major) hit(10 * major, `${major} major review comment${major === 1 ? '' : 's'} still open`);
  if (t.iterations >= 2) hit(10, `Needed ${t.iterations} rework loops`);

  score = Math.max(0, Math.min(100, score));
  // "high" means nothing needs a manual check: unproven criteria or red CI cap it at medium
  const unprovenCount = criteria.filter((c) => c.status !== 'proven').length;
  if ((unprovenCount || t.ci?.state === 'failure' || (tr && !tr.passed)) && score >= 80) score = 79;
  return { score, level: score >= 80 ? 'high' : score >= 55 ? 'medium' : 'low', reasons };
}
