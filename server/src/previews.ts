import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import type { Store } from './store.js';

const BASE_PORT = Number(process.env.FACTORY_PREVIEW_PORT ?? 5300);
const MAX_LOG = 400;

interface Running {
  proc: ChildProcess;
  port: number;
  log: string[];
}

function portFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

/**
 * Live preview: run the project's app from a ticket's own worktree on its own port,
 * so the PM can click through the actual change while reviewing it.
 */
export class Previews {
  private running = new Map<string, Running>();

  constructor(private store: Store) {
    // previews don't survive a server restart
    for (const t of store.tickets()) if (t.preview && t.preview.status !== 'stopped') store.updateTicket(t.id, { preview: { ...t.preview, status: 'stopped' } });
  }

  private async pickPort() {
    const used = new Set([...this.running.values()].map((r) => r.port));
    for (let p = BASE_PORT; p < BASE_PORT + 200; p++) if (!used.has(p) && (await portFree(p))) return p;
    throw new Error('No free port for a preview.');
  }

  logs(ticketId: string) {
    return this.running.get(ticketId)?.log ?? [];
  }

  async start(ticketId: string) {
    const t = this.store.ticket(ticketId);
    if (!t) throw new Error('Ticket not found');
    const p = this.store.project(t.projectId);
    if (this.store.settings().mode === 'mock' || !t.worktree) {
      throw Object.assign(new Error('Previews run your real app from the ticket’s branch — they need Live mode and a ticket that has started work.'), { status: 400 });
    }
    if (!p.previewCommand?.trim()) throw Object.assign(new Error(`Set a preview command for "${p.name}" in Settings → Projects.`), { status: 400 });
    if (this.running.has(ticketId)) return t.preview;

    const port = await this.pickPort();
    const cmd = p.previewCommand.replace(/\$PORT\b/g, String(port));
    const url = `http://localhost:${port}${p.previewPath?.startsWith('/') ? p.previewPath : `/${p.previewPath ?? ''}`}`;
    const proc = spawn(cmd, { cwd: t.worktree, shell: true, env: { ...process.env, PORT: String(port), BROWSER: 'none' }, detached: process.platform !== 'win32' });
    const r: Running = { proc, port, log: [] };
    this.running.set(ticketId, r);
    const push = (b: Buffer) => {
      for (const line of b.toString().split('\n')) if (line.trim()) r.log.push(line);
      if (r.log.length > MAX_LOG) r.log.splice(0, r.log.length - MAX_LOG);
    };
    proc.stdout?.on('data', push);
    proc.stderr?.on('data', push);
    proc.on('exit', (code) => {
      if (this.running.get(ticketId) !== r) return;
      this.running.delete(ticketId);
      const cur = this.store.ticket(ticketId);
      if (cur?.preview) this.store.updateTicket(ticketId, { preview: { ...cur.preview, status: code ? 'error' : 'stopped', error: code ? `Exited with code ${code}: ${r.log.slice(-3).join(' ')}` : undefined } });
    });
    this.store.updateTicket(ticketId, { preview: { port, url, status: 'starting', startedAt: Date.now() } });
    this.store.log({ ticketId, agent: 'factory', kind: 'status', text: `▶ Preview starting: ${cmd}` });

    // Mark it running once the port answers (dev servers can take a while to boot).
    void (async () => {
      for (let i = 0; i < 120; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        if (this.running.get(ticketId) !== r) return;
        if (await portOpen(port)) {
          const cur = this.store.ticket(ticketId);
          if (cur?.preview) this.store.updateTicket(ticketId, { preview: { ...cur.preview, status: 'running' } });
          this.store.log({ ticketId, agent: 'factory', kind: 'status', text: `▶ Preview ready at ${url}` });
          return;
        }
      }
    })();
    return this.store.ticket(ticketId)!.preview;
  }

  stop(ticketId: string) {
    const r = this.running.get(ticketId);
    if (r) {
      this.running.delete(ticketId);
      try {
        if (r.proc.pid && process.platform !== 'win32') process.kill(-r.proc.pid, 'SIGTERM'); // whole process group
        else r.proc.kill('SIGTERM');
      } catch {
        r.proc.kill('SIGTERM');
      }
    }
    const t = this.store.ticket(ticketId);
    if (t?.preview && t.preview.status !== 'stopped') this.store.updateTicket(ticketId, { preview: { ...t.preview, status: 'stopped' } });
  }

  stopAll() {
    for (const id of [...this.running.keys()]) this.stop(id);
  }
}
