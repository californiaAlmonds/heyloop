---
description: "Update docs/context (state, decisions, architecture) with what changed this session"
agent: "agent"
---
Update the project context files so the next session can start without this chat history.

1. Review what changed this session (code, design, plans). Use `git status` / `git diff --stat` if helpful.
2. Rewrite [state.md](../../docs/context/state.md) to match reality: phase, what works, next steps (ordered), open items, known limitations. Keep it under ~60 lines; drop anything stale.
3. Append to [decisions.md](../../docs/context/decisions.md) one line per new decision: `- YYYY-MM-DD — decision — why`. Never edit past entries; if a decision is reversed, add a new line saying so.
4. Update [architecture.md](../../docs/context/architecture.md) only if components, contracts, or data flow changed.
5. Reply with a 2–3 line summary of what was recorded. No other changes.
