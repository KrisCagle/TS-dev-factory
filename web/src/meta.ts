import type { AgentRole, Priority, Stage, TicketSource } from './types';

export const STAGE_META: Record<Stage, { label: string; hint: string; icon: string }> = {
  backlog: { label: 'Backlog', hint: 'Your staging area — agents ignore it', icon: '🗂' },
  ready: { label: 'Ready', hint: 'Queued for the factory', icon: '📥' },
  planning: { label: 'Planning', hint: 'Planner is designing the approach', icon: '🧭' },
  coding: { label: 'Coding', hint: 'Coder is implementing', icon: '⌨️' },
  testing: { label: 'Testing', hint: 'Tester is verifying', icon: '🧪' },
  reviewing: { label: 'Review', hint: 'Reviewer is the quality gate', icon: '🔍' },
  ci: { label: 'CI checks', hint: 'PR open — waiting for checks to go green', icon: '🚦' },
  awaiting_approval: { label: 'Needs you', hint: 'Waiting for PM approval', icon: '✋' },
  done: { label: 'Shipped', hint: 'Merged or PR opened', icon: '🚀' },
  failed: { label: 'Failed', hint: 'Something broke — retry or edit', icon: '⚠️' },
};

export const ACTIVE_STAGES: Stage[] = ['planning', 'coding', 'testing', 'reviewing'];

export const PRIORITY_META: Record<Priority, { label: string; color: string; rank: number }> = {
  urgent: { label: 'Urgent', color: '#ef4444', rank: 0 },
  high: { label: 'High', color: '#f97316', rank: 1 },
  medium: { label: 'Medium', color: '#eab308', rank: 2 },
  low: { label: 'Low', color: '#94a3b8', rank: 3 },
};

export const SOURCE_META: Record<TicketSource, { label: string; icon: string }> = {
  local: { label: 'Factory', icon: '🏭' },
  github: { label: 'GitHub', icon: '🐙' },
  linear: { label: 'Linear', icon: '◐' },
  jira: { label: 'Jira', icon: '◆' },
};

export const ROLE_META: Record<AgentRole, { icon: string; desc: string }> = {
  planner: { icon: '🧭', desc: 'Explores the code read-only and writes the plan' },
  coder: { icon: '⌨️', desc: 'Implements the change in an isolated worktree' },
  tester: { icon: '🧪', desc: 'Runs and writes tests, reports failures' },
  reviewer: { icon: '🔍', desc: 'Reviews the diff — the quality gate before you' },
};

export const ROLES: AgentRole[] = ['planner', 'coder', 'tester', 'reviewer'];

export function ago(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function duration(ms: number) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

export const money = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
export const compact = (n: number) => Intl.NumberFormat('en', { notation: 'compact' }).format(n);
