import { childEnv } from './runner.js';
import { createSdkMcpServer, query, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { SESSION_RULES, type SessionRunner, type TurnContext } from '../sessions.js';
import type { EngineSettings } from '../types.js';

/** Extra MCP servers (e.g. Scarif) and tools to hide, decided per turn. */
export type ExtraTools = () => { mcpServers: Record<string, McpServerConfig>; disallowedTools: string[] };

function summarize(name: string, input: Record<string, unknown>) {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  if (['Read', 'Write', 'Edit', 'MultiEdit'].includes(name)) return s('file_path');
  if (name === 'Bash') return s('command').slice(0, 200);
  if (name === 'Glob' || name === 'Grep') return s('pattern');
  if (name === 'Skill') return s('skill') || s('command');
  return JSON.stringify(input).slice(0, 160);
}

/** A real Claude Code session in the project's repo (Claude Agent SDK). */
export class ClaudeSessionRunner implements SessionRunner {
  constructor(private engine: () => EngineSettings, private extras: ExtraTools = () => ({ mcpServers: {}, disallowedTools: [] })) {}

  async turn(ctx: TurnContext) {
    const engine = this.engine();
    const abortController = new AbortController();
    ctx.signal.addEventListener('abort', () => abortController.abort(), { once: true });

    const factory = createSdkMcpServer({
      name: 'factory',
      version: '1.0.0',
      tools: [
        tool(
          'post_attention',
          'Post something to the PM’s queue: a decision (with options, your recommendation first), a question, a review of finished work (summary, setup, test cases) or a to-do they must do themselves. Returns immediately — never wait for the answer; it arrives as a later message.',
          {
            kind: z.enum(['decision', 'question', 'review', 'todo']),
            title: z.string().describe('One line, what you need'),
            body: z.string().optional().describe('Context in a few sentences of Markdown'),
            options: z.array(z.string()).optional().describe('For decisions: the choices, recommended first'),
            review: z.object({
              summary: z.string().optional(),
              setup: z.array(z.string()).optional(),
              cases: z.array(z.object({ title: z.string(), steps: z.array(z.string()), expect: z.string() })).optional(),
            }).optional(),
          },
          async (args) => {
            const id = ctx.postAttention(args);
            return { content: [{ type: 'text', text: `Posted to the PM's queue (${id}). Carry on; their answer will arrive as a message.` }] };
          },
        ),
      ],
    });

    const extra = this.extras();
    const mode = engine.permissionMode;
    const q = query({
      prompt: ctx.prompt,
      options: {
        cwd: ctx.cwd,
        env: childEnv(),
        model: engine.model || undefined,
        resume: ctx.session.sdkSessionId,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: SESSION_RULES },
        settingSources: engine.userSettings ? ['user', 'project', 'local'] : ['project', 'local'],
        plugins: ctx.pluginDirs.map((p) => ({ type: 'local' as const, path: p })),
        mcpServers: { factory, ...extra.mcpServers },
        disallowedTools: extra.disallowedTools,
        permissionMode: mode === 'bypass' ? 'bypassPermissions' : mode === 'ask' ? 'default' : 'acceptEdits',
        ...(mode === 'bypass' ? { allowDangerouslySkipPermissions: true } : {}),
        canUseTool: async (toolName, input, { suggestions }) => {
          if (toolName.startsWith('mcp__factory__')) return { behavior: 'allow', updatedInput: input };
          const r = await ctx.askPermission({ tool: toolName, input });
          return r.allow
            ? { behavior: 'allow', updatedInput: input, ...(r.always && suggestions ? { updatedPermissions: suggestions } : {}) }
            : { behavior: 'deny', message: r.message ?? 'Denied by the PM.' };
        },
        abortController,
      },
    });

    let text = '';
    let costUsd = 0;
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') ctx.sdkSession(msg.session_id);
      else if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            text = block.text;
            ctx.event({ kind: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            const name = block.name.replace(/^mcp__factory__/, '');
            ctx.event({ kind: 'tool', text: `${name} ${summarize(block.name, block.input as Record<string, unknown>)}` });
          }
        }
      } else if (msg.type === 'result') {
        costUsd = msg.total_cost_usd ?? 0;
        if (msg.subtype === 'success') text = msg.result || text;
        else throw new Error(`The session stopped: ${msg.subtype}${msg.errors?.length ? ` — ${msg.errors.join('; ')}` : ''}`);
      }
    }
    return { text, costUsd };
  }
}

/**
 * Simulated sessions: they read, edit and test, post reviews and decisions,
 * and ask for permission in "ask" mode — so the whole flow can be tried without Claude.
 */
export class MockSessionRunner implements SessionRunner {
  constructor(private speed = 1, private engine: () => EngineSettings) {}

  async turn(ctx: TurnContext) {
    const wait = (ms: number) => new Promise<void>((resolve, reject) => {
      if (ctx.signal.aborted) return reject(new Error('Stopped'));
      const t = setTimeout(resolve, Math.max(5, ms * this.speed));
      ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Stopped')); }, { once: true });
    });
    const p = ctx.prompt.toLowerCase();
    const first = ctx.session.turns === 0;
    const plugin = ctx.pluginDirs.length ? ` (with ${ctx.pluginDirs.length} process plugin${ctx.pluginDirs.length > 1 ? 's' : ''})` : '';
    ctx.sdkSession(ctx.session.sdkSessionId ?? `sim-${ctx.session.id.slice(0, 8)}`);
    const say = async (text: string, ms = 700) => { await wait(ms); ctx.event({ kind: 'text', text }); };
    const toolUse = async (text: string, ms = 600) => { await wait(ms); ctx.event({ kind: 'tool', text }); };

    // answers to things it posted
    if (/validated your review|every case passed|approved "/.test(p)) {
      await toolUse('Bash git push && gh pr create');
      return this.done(`Done. Opened the pull request and wrapped up.\n\nRESULT: Shipped — the PR is open for merge.`);
    }
    if (/wants changes|requested changes|feedback/.test(p)) {
      await say('Working through your feedback.');
      await toolUse('Edit src/feature.ts');
      await toolUse('Bash npm test');
      this.review(ctx, 'Changes from your feedback are in');
      return this.done('Addressed each point and re-ran the tests.\n\nREVIEW: Your feedback is addressed — please re-check.');
    }
    if (/answered your question|decided "/.test(p)) {
      await say('Thanks — going with that.');
      await toolUse('Edit src/feature.ts');
      return this.done('Applied your answer.\n\nRESULT: Updated per your decision.');
    }

    // a question: just answer it
    if (first && /^(what|why|how|where|which|who|is|are|does|do|can)\b/.test(p.trim()) && p.length < 240) {
      await toolUse('Grep ' + (p.match(/\b[a-z]{5,}\b/)?.[0] ?? 'main'));
      await toolUse('Read README.md');
      return this.done(`From the code: it's handled in \`src/\` — the entry point wires it up and the tests cover the main path.\n\nRESULT: Answered in the session.`);
    }

    await say(`On it${plugin}. Reading the code first.`);
    await toolUse('Glob src/**/*');
    await toolUse('Read src/index.ts');
    if (/decid|choose|which|option/.test(p)) {
      ctx.postAttention({ kind: 'decision', title: 'Which approach should I take?', body: 'Two reasonable ways to do this. I’ll start on the first unless you say otherwise.', options: ['Extend the existing module (smaller change)', 'Add a new service (cleaner, bigger)'] });
      await say('Posted a decision to your queue; starting with my recommendation.');
    }
    await toolUse('Edit src/feature.ts');
    if (this.engine().permissionMode === 'ask') {
      const r = await ctx.askPermission({ tool: 'Bash', input: { command: 'npm test', description: 'Run the test suite' } });
      if (!r.allow) return this.done(`Skipped running the tests (${r.message}).\n\nBLOCKED: I need to run the tests to finish.`);
    }
    await toolUse('Bash npm test');
    await say('Tests pass.');
    this.review(ctx, ctx.session.title);
    return this.done(`Implemented it and added tests.\n\nREVIEW: ${ctx.session.title} is ready to check.`);
  }

  private review(ctx: TurnContext, title: string) {
    ctx.postAttention({
      kind: 'review',
      title: `Review: ${title}`,
      review: {
        summary: `${title}. The change is small and covered by new tests.`,
        setup: ['git checkout the session branch', 'npm install && npm run dev'],
        cases: [
          { title: 'The happy path', steps: ['Open the app', 'Use the new behavior'], expect: 'It does what you asked' },
          { title: 'Empty input', steps: ['Leave the field empty', 'Submit'], expect: 'A clear message, no error' },
        ],
      },
    });
  }

  private done(text: string) {
    return { text, costUsd: 0 };
  }
}
