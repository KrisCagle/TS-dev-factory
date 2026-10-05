import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const pexec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await pexec('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(dir: string) {
  try {
    return (await git(dir, 'rev-parse', '--is-inside-work-tree')) === 'true';
  } catch {
    return false;
  }
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

export function worktreesRoot(repoPath: string, configured: string) {
  return configured || path.join(path.dirname(repoPath), `${path.basename(repoPath)}-factory-worktrees`);
}

/** Create (or reuse) an isolated worktree + branch for a ticket. */
export async function ensureWorktree(repoPath: string, root: string, baseBranch: string, key: string, title: string) {
  const branch = `factory/${key.toLowerCase()}-${slug(title)}`;
  const dir = path.join(root, key.toLowerCase());
  if (fs.existsSync(path.join(dir, '.git'))) return { branch, dir };
  fs.mkdirSync(root, { recursive: true });
  const exists = await git(repoPath, 'branch', '--list', branch);
  if (exists) await git(repoPath, 'worktree', 'add', dir, branch);
  else await git(repoPath, 'worktree', 'add', '-b', branch, dir, baseBranch);
  return { branch, dir };
}

/** Commit anything the agent left behind. Returns true if a commit was made. */
export async function commitAll(dir: string, message: string) {
  await git(dir, 'add', '-A');
  const status = await git(dir, 'status', '--porcelain');
  if (!status) return false;
  await git(dir, '-c', 'user.name=AI Dev Factory', '-c', 'user.email=factory@localhost', 'commit', '-m', message);
  return true;
}

export async function diffAgainstBase(dir: string, baseBranch: string) {
  return git(dir, 'diff', `${baseBranch}...HEAD`);
}

export async function mergeBranch(repoPath: string, branch: string, message: string) {
  await git(repoPath, '-c', 'user.name=AI Dev Factory', '-c', 'user.email=factory@localhost', 'merge', '--no-ff', branch, '-m', message);
}

export async function removeWorktree(repoPath: string, dir: string) {
  try {
    await git(repoPath, 'worktree', 'remove', '--force', dir);
  } catch {
    /* already gone */
  }
}

export async function pushBranch(dir: string, branch: string) {
  await git(dir, 'push', '-u', 'origin', branch);
}

/** Keep the factory's own scratch folder (screenshots etc.) out of the ticket's commits. */
export async function excludeFactoryDir(dir: string) {
  try {
    const common = await git(dir, 'rev-parse', '--git-common-dir');
    const file = path.resolve(dir, common, 'info', 'exclude');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!cur.split('\n').includes('.factory/')) fs.appendFileSync(file, `${cur.endsWith('\n') || !cur ? '' : '\n'}.factory/\n`);
  } catch {
    /* not fatal */
  }
}

export async function listFiles(dir: string) {
  const out = await git(dir, 'ls-files');
  return out ? out.split('\n') : [];
}

/** Run a shell command (e.g. the project's smoke test) and keep the tail of its output. */
export function runShell(cwd: string, command: string, timeoutMs = 10 * 60_000): Promise<{ code: number; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const p = spawn('bash', ['-lc', command], { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let out = '';
    const keep = (d: Buffer) => {
      out += d.toString();
      if (out.length > 16_000) out = out.slice(-12_000);
    };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGTERM');
    }, timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, output: `${out}\n${e.message}`.trim(), timedOut });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: out.trim().slice(-6_000), timedOut });
    });
  });
}

/** A throwaway checkout of `ref` (for smoke tests and reverts) that never touches your working copy. */
export async function tempWorktree(repoPath: string, ref: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-check-'));
  fs.rmSync(dir, { recursive: true, force: true });
  await git(repoPath, 'worktree', 'add', '--detach', dir, ref);
  return { dir, remove: () => removeWorktree(repoPath, dir) };
}

/** The ref for the latest base branch: origin/<base> after a fetch when there is a remote, otherwise the local branch. */
export async function latestBase(repoPath: string, base: string) {
  try {
    await git(repoPath, 'fetch', 'origin', base);
    return `origin/${base}`;
  } catch {
    return base;
  }
}

/** Undo a shipped commit with a new commit (merge commits are reverted against their first parent). */
export async function revertCommit(cwd: string, sha: string, message: string) {
  const parents = (await git(cwd, 'rev-list', '--parents', '-n', '1', sha)).split(' ').length - 1;
  const args = ['-c', 'user.name=AI Dev Factory', '-c', 'user.email=factory@localhost', 'revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), sha];
  await git(cwd, ...args);
  await git(cwd, '-c', 'user.name=AI Dev Factory', '-c', 'user.email=factory@localhost', 'commit', '--amend', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}
