---
description: Approve and ship a ticket that is waiting for your sign-off
allowed-tools: mcp__plugin_factory_factory__get_ticket, mcp__plugin_factory_factory__answer_inbox
argument-hint: <ticket key, e.g. FAC-12>
---
Look up ticket $ARGUMENTS with get_ticket. Show me its safety score and anything unproven or risky in two lines, then ask me to confirm. When I confirm, approve it with answer_inbox (option "ship", or "approve" for a plan).
