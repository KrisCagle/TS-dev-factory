import { execFile } from 'node:child_process';
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
