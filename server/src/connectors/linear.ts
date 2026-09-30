import type { Priority, Settings } from '../types.js';
import { http, type Connector } from './types.js';

async function gql<T>(s: Settings, query: string, variables: Record<string, unknown> = {}) {
  const r = await http<{ data?: T; errors?: Array<{ message: string }> }>('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: s.connectors.linear.apiKey || process.env.LINEAR_API_KEY || '' },
    json: { query, variables },
  });
  if (r.errors?.length) throw new Error(r.errors.map((e) => e.message).join('; '));
  return r.data as T;
}

const PRIORITY: Record<number, Priority> = { 0: 'medium', 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' };

async function moveToStateType(s: Settings, issueId: string, type: 'started' | 'completed') {
  const d = await gql<{ workflowStates: { nodes: Array<{ id: string }> } }>(
    s,
    `query($team:String!,$type:String!){ workflowStates(filter:{team:{key:{eq:$team}}, type:{eq:$type}}, first:1){ nodes{ id } } }`,
    { team: s.connectors.linear.teamKey, type },
  );
  const stateId = d.workflowStates.nodes[0]?.id;
  if (stateId) await gql(s, `mutation($id:String!,$stateId:String!){ issueUpdate(id:$id, input:{stateId:$stateId}){ success } }`, { id: issueId, stateId });
}

export const linear: Connector = {
  source: 'linear',
  label: 'Linear',
  isEnabled: (s) => s.connectors.linear.enabled && !!s.connectors.linear.teamKey,

  async pull(s) {
    const d = await gql<{ issues: { nodes: Array<{ id: string; identifier: string; title: string; description: string | null; url: string; priority: number; labels: { nodes: Array<{ name: string }> } }> } }>(
      s,
      `query($team:String!,$state:String!){ issues(filter:{team:{key:{eq:$team}}, state:{name:{eq:$state}}}, first:50){ nodes{ id identifier title description url priority labels{ nodes{ name } } } } }`,
      { team: s.connectors.linear.teamKey, state: s.connectors.linear.stateName },
    );
    return d.issues.nodes.map((i) => ({
      key: i.identifier, title: i.title, description: i.description ?? '', priority: PRIORITY[i.priority] ?? 'medium',
      labels: i.labels.nodes.map((l) => l.name), externalId: i.id, externalUrl: i.url,
    }));
  },

  async onStage(s, t, stage, message) {
    if (!t.externalId) return;
    await gql(s, `mutation($id:String!,$body:String!){ commentCreate(input:{issueId:$id, body:$body}){ success } }`, { id: t.externalId, body: `🏭 **AI Dev Factory** — ${message}` });
    if (stage === 'planning' || stage === 'coding') await moveToStateType(s, t.externalId, 'started');
    if (stage === 'done') await moveToStateType(s, t.externalId, 'completed');
  },

  async test(s) {
    const d = await gql<{ viewer: { name: string } }>(s, `query{ viewer{ name } }`);
    return `Connected to Linear as ${d.viewer.name}`;
  },
};
