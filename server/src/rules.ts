import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './store.js';

/**
 * House rules: conventions every agent follows for a project.
 * Stored in the repo's CLAUDE.md when the repo exists, otherwise in the factory's own data.
 */
export class Rules {
  constructor(private store: Store) {}

  private file(projectId: string) {
    const p = this.store.project(projectId);
    return p.repoPath && fs.existsSync(p.repoPath) ? path.join(p.repoPath, 'CLAUDE.md') : null;
  }

  get(projectId: string) {
    const f = this.file(projectId);
    if (f) return { text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '', where: f, inRepo: true };
    return { text: this.store.project(projectId).rules ?? '', where: 'factory settings', inRepo: false };
  }

  set(projectId: string, text: string) {
    const f = this.file(projectId);
    if (f) fs.writeFileSync(f, text.endsWith('\n') ? text : `${text}\n`);
    else {
      const s = this.store.settings();
      this.store.updateSettings({ projects: s.projects.map((p) => (p.id === projectId ? { ...p, rules: text } : p)) });
    }
    return this.get(projectId);
  }

  /** Recent PM feedback on this project's tickets — candidates for standing rules. */
  suggestions(projectId: string) {
    const seen = new Set<string>();
    const out: Array<{ text: string; ticket: string; ts: number }> = [];
    const current = this.get(projectId).text.toLowerCase();
    const tickets = this.store.tickets().filter((t) => t.projectId === projectId);
    for (const t of tickets) {
      for (const n of t.notes) {
        for (const raw of n.text.split('\n')) {
          const line = raw.replace(/^PM review feedback:\s*/i, '').replace(/^-\s*(Case \d+ \([^)]*\)|General):\s*/, '').trim();
          if (line.length < 12 || seen.has(line.toLowerCase()) || current.includes(line.toLowerCase())) continue;
          seen.add(line.toLowerCase());
          out.push({ text: line, ticket: t.key, ts: n.ts });
        }
      }
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, 15);
  }

  /** Rules text to hand every agent (trimmed so prompts stay reasonable). */
  forPrompt(projectId: string) {
    const t = this.get(projectId).text.trim();
    return t ? t.slice(0, 8000) : '';
  }
}
