---
name: factory-pm
description: Use when the user mentions their AI Dev Factory, factory tickets (keys like FAC-12), the agents' work, sign-offs, or wants to turn something into a ticket. Explains how to use the factory tools well.
---
# Working with AI Dev Factory

The factory is a local app where four agents (Planner, Coder, Tester, Reviewer) work tickets and the user signs off as PM. The `factory` MCP tools talk to it (default http://localhost:4317; set FACTORY_URL to change it).

- Start with `factory_status` to see what's going on. Refer to tickets by key (FAC-12).
- To turn an idea, bug, error or thread into work: `draft_ticket` first, show the draft, then `create_ticket`. Keep acceptance criteria as "- [ ]" items under "## Acceptance criteria"; the Tester proves each one.
- Sign-offs: `inbox` lists them with a recommendation and safety score. Never approve, send back, revert or retry without the user deciding. A send back needs a note for the agents.
- Questions about a ticket's code or progress: `ask_ticket`. Extra direction for the agents: `add_note`.
- If a tool says the factory can't be reached, tell the user to start it (`npm start` in the ai-dev-factory folder) rather than retrying.
