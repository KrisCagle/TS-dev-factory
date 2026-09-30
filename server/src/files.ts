import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as g from './git.js';
import type { Store } from './store.js';
import type { Ticket } from './types.js';

const MAX_BYTES = 512 * 1024;

/** Files changed in a unified diff. */
export function changedFiles(diff = '') {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    const m = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
    if (m) files.push(m[2]);
  }
  return files;
}

/** Content of a file as it appears on the + side of a diff (used in simulated mode). */
function fromDiff(diff: string, file: string) {
  const out: string[] = [];
  let inFile = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) inFile = line.endsWith(` b/${file}`);
    else if (inFile && !/^(index |--- |\+\+\+ |@@|new file)/.test(line) && !line.startsWith('-')) out.push(line.replace(/^[+ ]/, ''));
  }
  return out.join('\n');
}

/** Read-only code viewer over a ticket's worktree. */
export class FileBrowser {
  constructor(private store: Store) {}

  private ticket(id: string) {
    const t = this.store.ticket(id);
    if (!t) throw Object.assign(new Error('Ticket not found'), { status: 404 });
    return t;
  }

  async list(id: string) {
    const t = this.ticket(id);
    const changed = changedFiles(t.diff);
    if (!t.worktree || !fs.existsSync(t.worktree)) return { changed, files: changed, live: false };
    return { changed, files: await g.listFiles(t.worktree), live: true };
  }

  read(id: string, rel: string) {
    const t = this.ticket(id);
    if (!t.worktree || !fs.existsSync(t.worktree)) return { path: rel, content: fromDiff(t.diff ?? '', rel), fromDiff: true };
    const root = path.resolve(t.worktree);
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep)) throw Object.assign(new Error('Path outside the worktree'), { status: 400 });
    const st = fs.statSync(full);
    if (st.size > MAX_BYTES) return { path: rel, content: `(${Math.round(st.size / 1024)} KB — too large to show here; open it in your editor)`, tooLarge: true };
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return { path: rel, content: '(binary file)', binary: true };
    return { path: rel, content: buf.toString('utf8') };
  }

  /** Open the ticket's worktree in VS Code (falls back to the macOS `open` command). */
  openInEditor(id: string) {
    const t: Ticket = this.ticket(id);
    const dir = t.worktree && fs.existsSync(t.worktree) ? t.worktree : this.store.project(t.projectId).repoPath;
    if (!dir) throw Object.assign(new Error('This ticket has no working copy yet.'), { status: 400 });
    return new Promise<{ opened: string }>((resolve, reject) => {
      const p = spawn('code', [dir], { stdio: 'ignore' });
      p.on('error', () => {
        if (process.platform !== 'darwin') return reject(new Error('Couldn’t find the `code` command. In VS Code run “Shell Command: Install code command in PATH”.'));
        const o = spawn('open', ['-a', 'Visual Studio Code', dir], { stdio: 'ignore' });
        o.on('error', (e) => reject(e));
        o.on('exit', (c) => (c === 0 ? resolve({ opened: dir }) : reject(new Error('VS Code isn’t installed.'))));
      });
      p.on('spawn', () => resolve({ opened: dir }));
    });
  }
}
