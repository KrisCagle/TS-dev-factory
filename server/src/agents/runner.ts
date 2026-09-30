import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentConfig, LogKind } from '../types.js';

export interface RunOptions {
  agent: AgentConfig;
  prompt: string;
  cwd: string;
  schema?: Record<string, unknown>;
  signal: AbortSignal;
  budgetUsd?: number;
  onEvent: (kind: LogKind, text: string) => void;
}

export interface RunResult {
  text: string;
  structured?: unknown;
  costUsd: number;
  tokens: number;
}

export interface AgentRunner {
  run(opts: RunOptions): Promise<RunResult>;
}

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return pick('file_path');
    case 'Bash':
      return pick('command').slice(0, 200);
    case 'Glob':
    case 'Grep':
      return pick('pattern');
    default:
      return JSON.stringify(input).slice(0, 160);
  }
}

/** Runs an agent with the Claude Agent SDK inside the ticket's worktree. */
export class ClaudeRunner implements AgentRunner {
  async run({ agent, prompt, cwd, schema, signal, budgetUsd, onEvent }: RunOptions): Promise<RunResult> {
    const abortController = new AbortController();
    signal.addEventListener('abort', () => abortController.abort(), { once: true });

    const q = query({
      prompt,
      options: {
        cwd,
        model: agent.model,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: agent.systemPrompt },
        allowedTools: agent.allowedTools,
        permissionMode: 'acceptEdits',
        maxTurns: agent.maxTurns,
        abortController,
        settingSources: ['project'], // pick up the repo's CLAUDE.md
        ...(budgetUsd ? { maxBudgetUsd: budgetUsd } : {}),
        ...(schema ? { outputFormat: { type: 'json_schema' as const, schema } } : {}),
      },
    });

    let text = '';
    let structured: unknown;
    let costUsd = 0;
    let tokens = 0;

    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            text = block.text;
            onEvent('text', block.text);
          } else if (block.type === 'tool_use') {
            onEvent('tool', `${block.name} ${summarizeToolInput(block.name, block.input as Record<string, unknown>)}`);
          }
        }
      } else if (msg.type === 'result') {
        costUsd = msg.total_cost_usd ?? 0;
        const u = msg.usage;
        tokens = (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
        if (msg.subtype === 'success') {
          if (msg.result) text = msg.result;
          structured = msg.structured_output;
        } else {
          throw new Error(`${agent.name} stopped: ${msg.subtype}${msg.errors?.length ? ` — ${msg.errors.join('; ')}` : ''}`);
        }
      }
    }

    if (schema && structured === undefined) structured = extractJson(text);
    return { text, structured, costUsd, tokens };
  }
}

/** Fallback: pull the last JSON object out of free text. */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/g);
  const candidates = fence ? fence.map((f) => f.replace(/```(?:json)?/g, '')) : [];
  const last = text.lastIndexOf('{');
  if (last >= 0) candidates.push(text.slice(text.indexOf('{')));
  for (const c of candidates.reverse()) {
    try {
      return JSON.parse(c.trim());
    } catch {
      /* next */
    }
  }
  return undefined;
}
