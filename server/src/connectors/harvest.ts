import type { Settings } from '../types.js';
import { http } from './types.js';

/**
 * Harvest v2 time tracking (https://help.getharvest.com/api-v2/).
 * Auth is a personal access token + account id from Harvest ID → Developers.
 */
const BASE = 'https://api.harvestapp.com/v2';

function headers(s: Settings) {
  const token = s.harvest.token || process.env.HARVEST_TOKEN || '';
  const account = s.harvest.accountId || process.env.HARVEST_ACCOUNT_ID || '';
  return {
    Authorization: `Bearer ${token}`,
    'Harvest-Account-Id': account,
    'User-Agent': 'AI Dev Factory (https://github.com/KrisCagle/ai-dev-factory)',
  };
}

export const harvestConfigured = (s: Settings) =>
  s.harvest.enabled && !!(s.harvest.token || process.env.HARVEST_TOKEN) && !!(s.harvest.accountId || process.env.HARVEST_ACCOUNT_ID);

export interface HarvestProject {
  id: number;
  name: string;
  code: string | null;
  client: string | null;
  tasks: Array<{ id: number; name: string }>;
}

export interface HarvestEntry {
  id: number;
  hours: number;
  is_running: boolean;
  notes: string | null;
  spent_date: string;
  timer_started_at: string | null;
  project: { id: number; name: string };
  task: { id: number; name: string };
}

/** Local date (not UTC) — Harvest's spent_date is the user's calendar day. */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let meCache: { key: string; id: number } | null = null;

export const harvest = {
  async me(s: Settings) {
    return http<{ id: number; first_name: string; last_name: string; email: string }>(`${BASE}/users/me`, { headers: headers(s) });
  },

  async projects(s: Settings): Promise<HarvestProject[]> {
    const r = await http<{
      project_assignments: Array<{
        is_active: boolean;
        project: { id: number; name: string; code: string | null };
        client: { name: string } | null;
        task_assignments: Array<{ is_active: boolean; task: { id: number; name: string } }>;
      }>;
    }>(`${BASE}/users/me/project_assignments?per_page=2000`, { headers: headers(s) });
    return r.project_assignments
      .filter((a) => a.is_active)
      .map((a) => ({
        id: a.project.id,
        name: a.project.name,
        code: a.project.code,
        client: a.client?.name ?? null,
        tasks: a.task_assignments.filter((t) => t.is_active).map((t) => t.task),
      }));
  },

  /** Omitting hours makes Harvest start a running timer. */
  async startTimer(s: Settings, projectId: number, taskId: number, notes: string) {
    return http<HarvestEntry>(`${BASE}/time_entries`, {
      method: 'POST',
      headers: headers(s),
      json: { project_id: projectId, task_id: taskId, spent_date: today(), notes },
    });
  },

  async stopTimer(s: Settings, entryId: number) {
    return http<HarvestEntry>(`${BASE}/time_entries/${entryId}/stop`, { method: 'PATCH', headers: headers(s) });
  },

  async logHours(s: Settings, projectId: number, taskId: number, hours: number, notes: string) {
    return http<HarvestEntry>(`${BASE}/time_entries`, {
      method: 'POST',
      headers: headers(s),
      json: { project_id: projectId, task_id: taskId, spent_date: today(), hours, notes },
    });
  },

  async todayEntries(s: Settings) {
    const d = today();
    const key = `${s.harvest.accountId}:${(s.harvest.token || '').slice(-6)}`;
    if (meCache?.key !== key) meCache = { key, id: (await harvest.me(s)).id };
    const r = await http<{ time_entries: HarvestEntry[] }>(`${BASE}/time_entries?from=${d}&to=${d}&user_id=${meCache.id}&per_page=200`, { headers: headers(s) });
    return r.time_entries;
  },
};
