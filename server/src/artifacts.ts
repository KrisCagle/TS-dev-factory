import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Artifact } from './types.js';

const IMG = /\.(png|jpe?g|webp|gif|svg)$/i;

/** Screenshots and other files attached to tickets, shown next to the review cases. */
export class Artifacts {
  constructor(private store: Store) {}

  private dir(ticketId: string) {
    const d = path.join(this.store.dataDir, 'artifacts', ticketId);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  private add(ticketId: string, a: Omit<Artifact, 'id' | 'createdAt'>) {
    const t = this.store.ticket(ticketId);
    if (!t) return;
    const list = (t.artifacts ?? []).filter((x) => x.name !== a.name);
    list.push({ ...a, id: randomUUID(), createdAt: Date.now() });
    this.store.updateTicket(ticketId, { artifacts: list });
  }

  /** Pick up screenshots the Tester saved into .factory/screenshots in the worktree. */
  async collect(ticketId: string, cwd: string) {
    if (this.store.settings().mode === 'mock') return;
    const src = path.join(cwd, '.factory', 'screenshots');
    if (!fs.existsSync(src)) return;
    const files = fs.readdirSync(src).filter((f) => IMG.test(f)).sort();
    for (const f of files) {
      const dest = path.join(this.dir(ticketId), f);
      fs.copyFileSync(path.join(src, f), dest);
      this.add(ticketId, { name: f, file: dest, caption: f.replace(IMG, '').replace(/^\d+[-_]/, '').replace(/[-_]/g, ' ') });
    }
    if (files.length) this.store.log({ ticketId, agent: 'tester', kind: 'result', text: `📸 ${files.length} screenshot${files.length === 1 ? '' : 's'} attached` });
  }

  /** After review: tie screenshots to cases (by name when the reviewer named one). */
  async link(ticketId: string) {
    const t = this.store.ticket(ticketId);
    const cases = t?.review?.walkthrough?.cases;
    if (!t || !cases) return;
    if (this.store.settings().mode === 'mock') {
      cases.forEach((c, i) => {
        const name = `case-${i + 1}.svg`;
        const dest = path.join(this.dir(ticketId), name);
        fs.writeFileSync(dest, mockScreenshot(t.key, c.title, c.expect, i));
        this.add(ticketId, { name, file: dest, caseIndex: i, caption: c.expect });
      });
      return;
    }
    const arts = (this.store.ticket(ticketId)?.artifacts ?? []).map((a) => {
      const i = cases.findIndex((c) => c.screenshot && (c.screenshot === a.name || c.screenshot.endsWith(`/${a.name}`)));
      return i >= 0 ? { ...a, caseIndex: i } : a;
    });
    this.store.updateTicket(ticketId, { artifacts: arts });
  }

  file(ticketId: string, artifactId: string) {
    const a = this.store.ticket(ticketId)?.artifacts?.find((x) => x.id === artifactId);
    if (!a || !fs.existsSync(a.file)) throw Object.assign(new Error('Not found'), { status: 404 });
    return a.file;
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A clearly-fake app screenshot for simulated mode, so the review UI can be tried. */
function mockScreenshot(key: string, title: string, expect: string, i: number) {
  const hue = (i * 70 + 220) % 360;
  const wrap = (s: string, n: number) => (s.match(new RegExp(`.{1,${n}}(\\s|$)`, 'g')) ?? [s]).slice(0, 3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500" font-family="system-ui, sans-serif">
  <rect width="800" height="500" fill="#f8fafc"/>
  <rect width="800" height="44" fill="hsl(${hue} 60% 45%)"/>
  <circle cx="22" cy="22" r="6" fill="#fff" opacity=".7"/><circle cx="42" cy="22" r="6" fill="#fff" opacity=".5"/><circle cx="62" cy="22" r="6" fill="#fff" opacity=".3"/>
  <text x="90" y="28" fill="#fff" font-size="15" font-weight="600">localhost:3000 — ${esc(key)}</text>
  <rect x="0" y="44" width="180" height="456" fill="#e2e8f0"/>
  ${[0, 1, 2, 3, 4].map((r) => `<rect x="20" y="${74 + r * 36}" width="${110 + ((r * 23) % 40)}" height="12" rx="6" fill="#cbd5e1"/>`).join('')}
  <text x="210" y="96" font-size="22" font-weight="700" fill="#0f172a">${esc(title.slice(0, 48))}</text>
  <rect x="210" y="120" width="540" height="150" rx="12" fill="#fff" stroke="#e2e8f0"/>
  ${[0, 1, 2].map((r) => `<rect x="232" y="${144 + r * 32}" width="${420 - r * 90}" height="12" rx="6" fill="#e2e8f0"/>`).join('')}
  <rect x="210" y="290" width="540" height="${40 + wrap(expect, 60).length * 22}" rx="12" fill="hsl(150 60% 95%)" stroke="hsl(150 50% 60%)"/>
  <text x="232" y="318" font-size="12" font-weight="700" fill="hsl(150 60% 30%)">SIMULATED SCREENSHOT</text>
  ${wrap(expect, 60).map((l, k) => `<text x="232" y="${344 + k * 22}" font-size="15" fill="#0f172a">${esc(l.trim())}</text>`).join('')}
</svg>`;
}
