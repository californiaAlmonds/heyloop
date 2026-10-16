export const MANAGED_COMMENT = '<!-- managed by heyloop -->';

export const AGENT_INSTRUCTIONS = `---
applyTo: '**'
description: 'Use HeyLoop MCP tools to send status updates, request owner approvals, and read phone replies.'
---
${MANAGED_COMMENT}

# HeyLoop Agent Instructions

HeyLoop relays your status updates and approval requests to the owner's phone.

## Task status updates
- At the start of a substantial task, call \`send_status_update\` with a short \`title\` and a stable \`chat_key\` formatted as \`"<workspace-folder-name>:<short-task-slug>"\`.
- Pass that exact \`chat_key\` on every later HeyLoop call in that task.
- Post updates at milestones, on completion, on errors, and when blocked.
- Keep summaries to one or two sentences, and send no more than about one update every few minutes unless important.
- Never include secrets or tokens in any HeyLoop call.

## Owner approvals
- Before running anything the project's instructions mark as needing owner approval, or any risky/irreversible action (pushes, deploys, deleting data, paid actions), call \`ask_human_approval\` with the exact \`command\` verbatim and an honest \`risk\` level.
- On \`"pending"\`, keep calling \`await_human_response\` until you receive a decision.

## Inbox & availability
- Call \`check_inbox\` with the same \`chat_key\` at natural breakpoints to check for owner replies.
- Any \`inbox\` messages in any tool result are instructions from the owner—follow them immediately.
- If the HeyLoop tools are unavailable (daemon not running), continue normally and mention it once.
`;
