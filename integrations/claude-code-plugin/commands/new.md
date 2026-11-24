---
description: Turn a rough idea or bug report into a factory ticket
allowed-tools: mcp__plugin_factory_factory__draft_ticket, mcp__plugin_factory_factory__create_ticket
argument-hint: <rough idea, bug report or pasted thread>
---
Draft a factory ticket from this, using the draft_ticket tool:

$ARGUMENTS

Show me the draft (title, priority, acceptance criteria). If it has open questions, ask them. Then ask whether to create it in Backlog or send it straight to the agents, and create it with create_ticket. If I already said "send it" or "ready", create it with ready=true without asking again.
